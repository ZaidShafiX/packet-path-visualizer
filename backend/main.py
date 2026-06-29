from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
import asyncio
import re
import json
import random
import string
import geoip2.database
import httpx
import ipaddress
import urllib.request
import time
import socket
import os
import logging
import logging.handlers
import queue
from datetime import datetime

# ── Logging setup ─────────────────────────────────────────────────────────────
# Built-in `logging` only (no third-party deps). Every call site logs through
# the `packet_visualizer` logger via the log_event() helper below, which tags
# each line with a COMPONENT and arbitrary JSON metadata.
#
# Non-blocking by design: log_event() only ever touches a QueueHandler, which
# does nothing but push the record onto an in-memory queue — essentially
# instant, never touches disk. A single background thread (QueueListener)
# owns the actual FileHandler/StreamHandler and does the real (blocking)
# writes off of the asyncio event loop entirely, so a slow disk can never
# stall a live traceroute or WebRTC signaling connection.
LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f"app_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")


class PacketVisualizerFormatter(logging.Formatter):
    """
    [TIMESTAMP] [LEVEL] [COMPONENT] - Message | Metadata: {JSON_STRING}
    COMPONENT and metadata are supplied per-call via log_event()'s `extra=`
    dict; both fall back to sane defaults if a raw logger.* call bypasses it.
    """
    def format(self, record):
        timestamp     = self.formatTime(record, "%Y-%m-%d %H:%M:%S")
        component     = getattr(record, "component", "GENERAL")
        metadata      = getattr(record, "metadata", None) or {}
        metadata_json = json.dumps(metadata, default=str)
        return (
            f"[{timestamp}] [{record.levelname}] [{component}] - "
            f"{record.getMessage()} | Metadata: {metadata_json}"
        )


_log_queue    = queue.Queue(-1)
_queue_handler = logging.handlers.QueueHandler(_log_queue)

logger = logging.getLogger("packet_visualizer")
logger.setLevel(logging.DEBUG)
logger.addHandler(_queue_handler)
logger.propagate = False

_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setLevel(logging.DEBUG)      # everything → file
_file_handler.setFormatter(PacketVisualizerFormatter())

_stream_handler = logging.StreamHandler()
_stream_handler.setLevel(logging.INFO)     # console stays quiet; DEBUG (per-hop, SDP/ICE) is file-only
_stream_handler.setFormatter(PacketVisualizerFormatter())

_queue_listener = logging.handlers.QueueListener(
    _log_queue, _file_handler, _stream_handler, respect_handler_level=True
)
_queue_listener.start()


def log_event(level: int, component: str, message: str, **metadata) -> None:
    """Structured logging helper used everywhere instead of print()."""
    logger.log(level, message, extra={"component": component, "metadata": metadata})


# ── Application lifespan ──────────────────────────────────────────────────────
# FastAPI deprecated @app.on_event("startup") in v0.93 in favour of the
# lifespan context manager below. Using the old decorator still works but
# raises a DeprecationWarning on every boot and will be removed in a future
# release, so we switch here. Behaviour is identical: the stale-room cleanup
# task is created before the first request is served.

@asynccontextmanager
async def lifespan(app: FastAPI):
    log_event(logging.INFO, "STARTUP", "Packet Path Visualizer backend started",
              log_file=LOG_FILE)
    asyncio.create_task(cleanup_stale_rooms())
    yield
    # Graceful shutdown: flush the non-blocking log queue before the process exits
    # so the final few records aren't dropped mid-write.
    _queue_listener.stop()


app = FastAPI(lifespan=lifespan)

# ── CORS — open for local + ngrok dev ────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Ngrok browser-warning bypass ─────────────────────────────────────────────
class NgrokHeaderMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["ngrok-skip-browser-warning"] = "true"
        return response


app.add_middleware(NgrokHeaderMiddleware)

GEOIP_DB = "backend/GeoLite2-City.mmdb"

TARGETS = {
    "google":     "8.8.8.8",
    "cloudflare": "1.1.1.1",
    "london":     "151.101.0.81",
    "tokyo":      "54.65.0.1",
    "new-york":   "151.101.112.81",
}

_cable_cache = None


@app.get("/api/cables")
async def get_cables():
    global _cable_cache
    if _cable_cache is None:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
                timeout=10.0,
            )
            resp.raise_for_status()
            _cable_cache = resp.json()
    return _cable_cache


# Signaling rooms: { code: { "host": ws, "guest": ws | None, "created_at": float } }
rooms = {}

# Rooms older than this get reaped even if no clean disconnect ever arrived
# (covers crashed tabs, lost network, closed laptops — anything that doesn't
# send a proper WebSocket close frame).
ROOM_TTL_SECONDS       = 10 * 60   # 10 minutes
CLEANUP_INTERVAL_SECONDS = 60


async def cleanup_stale_rooms():
    """Background loop: periodically remove rooms that have outlived their TTL."""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        now   = time.time()
        stale = [code for code, r in rooms.items() if now - r["created_at"] > ROOM_TTL_SECONDS]
        for code in stale:
            log_event(logging.INFO, "SIGNALING", "Room expired and was removed",
                      room_id=code, reason="ttl_expired")
            del rooms[code]


# ── Helpers ───────────────────────────────────────────────────────────────────

def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))


def parse_ip_from_line(line):
    """Extract and return the first IP address found in a traceroute line."""
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    return ips[0] if ips else None


def parse_rtt_from_line(line):
    """
    Extract average RTT in milliseconds from a traceroute output line.

    Traceroute sends three probes per hop and prints each result separately,
    e.g. "  3  8.8.8.8  1.234 ms  1.456 ms  1.789 ms"
    Some probes may time out (shown as '*'), leaving fewer than three RTT
    values.  We collect every "N ms" token, average them, and round to 2 dp.
    If no RTT values are present (all-timeout line) we return None.
    """
    rtts = re.findall(r'(\d+\.?\d*)\s*ms', line)
    if not rtts:
        return None
    values = [float(r) for r in rtts]
    return round(sum(values) / len(values), 2)


def is_public_ip(ip):
    """Used only by /trace-ip endpoint to reject private peer IPs."""
    parts = ip.split(".")
    a, b  = int(parts[0]), int(parts[1])
    if a == 10:                        return False
    if a == 172 and 16 <= b <= 31:     return False
    if a == 192 and b == 168:          return False
    if a == 127:                       return False
    return True


def geolocate(ip, reader):
    """Try to geolocate an IP using the local MaxMind GeoLite2 database."""
    try:
        r   = reader.city(ip)
        lat, lng = r.location.latitude, r.location.longitude
        if lat is None or lng is None:
            return None
        city    = r.city.name    or "Unknown city"
        country = r.country.name or "Unknown country"
        return {"city": f"{city}, {country}", "lat": lat, "lng": lng}
    except Exception:
        return None


def fallback_geolocate(ip):
    """
    Fallback geolocation via ip-api.com for IPs MaxMind can't resolve
    (e.g. backbone routers, anycast addresses). Runs in a thread via
    asyncio.to_thread so it doesn't block the event loop.
    """
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,city,country,isp,lat,lon"
        with urllib.request.urlopen(url, timeout=3) as resp:
            data = json.loads(resp.read().decode())
        if data.get("status") != "success":
            return None
        city    = data.get("city",    "Unknown")
        country = data.get("country", "Unknown")
        isp     = data.get("isp",     "")
        lat     = data.get("lat")
        lon     = data.get("lon")
        if lat is None or lon is None:
            return None
        city_label = f"{city}, {country}"
        if isp:
            city_label += f" [{isp}]"
        return {"city": city_label, "lat": lat, "lng": lon}
    except Exception:
        return None


async def get_geolocation(ip, reader):
    """
    Async wrapper around the existing MaxMind → ip-api.com fallback chain,
    so geolocation can run inside asyncio.gather() alongside the other
    enrichment lookups below instead of blocking ahead of them.
    """
    geo = geolocate(ip, reader)
    if geo is None:
        geo = await asyncio.to_thread(fallback_geolocate, ip)
    return geo


async def reverse_dns_lookup(ip):
    """
    Modular enrichment source #1: reverse DNS (PTR record).
    socket.gethostbyaddr is blocking, so it runs in a thread via
    asyncio.to_thread; asyncio.wait_for puts a hard ceiling on it so a slow
    resolver can never stall the trace. Returns the hostname string, or
    None if there's no PTR record / the lookup fails / it times out.
    """
    try:
        hostname, _, _ = await asyncio.wait_for(
            asyncio.to_thread(socket.gethostbyaddr, ip), timeout=2.0
        )
        log_event(logging.DEBUG, "ENRICHMENT", "Reverse DNS lookup succeeded",
                  ip=ip, hostname=hostname)
        return hostname
    except Exception as e:
        log_event(logging.WARNING, "ENRICHMENT", "Reverse DNS lookup failed",
                  ip=ip, error=str(e))
        return None


def _asn_lookup_sync(ip):
    """Blocking half of the ASN lookup — runs inside asyncio.to_thread."""
    url = f"http://ip-api.com/json/{ip}?fields=status,as,org"
    with urllib.request.urlopen(url, timeout=2) as resp:
        return json.loads(resp.read().decode())


async def asn_bgp_lookup(ip):
    """
    Modular enrichment source #2: ASN / organization data.

    Originally implemented against api.bgpview.io, which was permanently
    shut down on 2025-11-26 — every call to it now fails closed. Swapped to
    ip-api.com's `as`/`org` fields instead: same free, key-less source
    already used for the geolocation fallback, so no new dependency or new
    failure mode introduced.

    Returns {"asn": int|None, "org": str|None, "prefix": None}. `prefix`
    stays None — ip-api.com doesn't expose the announced CIDR block.
    """
    try:
        data = await asyncio.wait_for(
            asyncio.to_thread(_asn_lookup_sync, ip), timeout=2.0
        )
        if data.get("status") != "success":
            log_event(logging.WARNING, "ENRICHMENT", "ASN lookup returned non-success status",
                      ip=ip, status=data.get("status"))
            return None

        as_field = data.get("as") or ""   # e.g. "AS15169 Google LLC"
        org      = data.get("org") or None

        asn = None
        if as_field.startswith("AS"):
            number_part = as_field.split(" ", 1)[0][2:]
            if number_part.isdigit():
                asn = int(number_part)

        if asn is None and org is None:
            log_event(logging.WARNING, "ENRICHMENT", "ASN lookup returned no usable data", ip=ip)
            return None
        log_event(logging.DEBUG, "ENRICHMENT", "ASN lookup succeeded", ip=ip, asn=asn, org=org)
        return {"asn": asn, "org": org, "prefix": None}
    except Exception as e:
        log_event(logging.WARNING, "ENRICHMENT", "ASN lookup failed", ip=ip, error=str(e))
        return None


async def run_trace(websocket, target_ip):
    """Shared traceroute logic used by both /trace and /trace-ip."""
    process = await asyncio.create_subprocess_exec(
        "traceroute", "-n", "-m", "20", target_ip,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    hop_number = 0
    with geoip2.database.Reader(GEOIP_DB) as reader:
        async for raw_line in process.stdout:
            line = raw_line.decode("utf-8").strip()
            if line.startswith("traceroute"):
                continue
            hop_number += 1

            ip  = parse_ip_from_line(line)
            rtt = parse_rtt_from_line(line)  # None when all probes timed out

            # ── Timeout / no response ─────────────────────────────────────────
            if ip is None:
                log_event(logging.DEBUG, "TRACE", "Hop timed out (no response)", hop=hop_number)
                await websocket.send_text(json.dumps({
                    "hop": hop_number,
                    "city": "Unknown (timeout)",
                    "lat": None, "lng": None,
                    "timeout": True, "is_private": False, "no_location": False,
                    "hostname": None, "asn": None, "org": None, "prefix": None,
                    "lookup_status": "skipped",
                    "rtt": None,
                }))
                continue

            # ── Private / Reserved / CGNAT check ─────────────────────────────
            try:
                addr  = ipaddress.ip_address(ip)
                cgnat = addr in ipaddress.ip_network("100.64.0.0/10")
                if addr.is_private or addr.is_reserved or cgnat:
                    log_event(logging.DEBUG, "TRACE", "Private/reserved IP hop discovered",
                              hop=hop_number, ip=ip, rtt=rtt)
                    await websocket.send_text(json.dumps({
                        "hop": hop_number, "ip": ip,
                        "city": "Local / ISP Network",
                        "lat": None, "lng": None,
                        "timeout": False, "is_private": True, "no_location": False,
                        "hostname": None, "asn": None, "org": None, "prefix": None,
                        "lookup_status": "skipped",
                        "rtt": rtt,
                    }))
                    continue
            except ValueError:
                pass

            # ── Public IP: geolocation, reverse DNS, and ASN/BGP concurrently ─
            geo, hostname, asn_info = await asyncio.gather(
                get_geolocation(ip, reader),
                reverse_dns_lookup(ip),
                asn_bgp_lookup(ip),
            )

            asn    = asn_info["asn"]    if asn_info else None
            org    = asn_info["org"]    if asn_info else None
            prefix = asn_info["prefix"] if asn_info else None

            enriched_hits = sum(1 for v in (hostname, asn) if v is not None)
            if enriched_hits == 2:
                lookup_status = "complete"
            elif enriched_hits == 1:
                lookup_status = "partial"
            else:
                lookup_status = "unavailable"

            if geo is None:
                city, lat, lng, no_location = f"{ip} (no location data)", None, None, True
            else:
                city, lat, lng, no_location = geo["city"], geo["lat"], geo["lng"], False

            payload = {
                "hop": hop_number, "ip": ip,
                "city": city, "lat": lat, "lng": lng,
                "timeout": False, "is_private": False, "no_location": no_location,
                "hostname": hostname, "asn": asn, "org": org, "prefix": prefix,
                "lookup_status": lookup_status,
                "rtt": rtt,
            }
            log_event(logging.DEBUG, "TRACE", "Hop discovered",
                      hop=hop_number, ip=ip, city=city, rtt=rtt, asn=asn,
                      hostname=hostname, lookup_status=lookup_status)
            await websocket.send_text(json.dumps(payload))

    await process.wait()
    await websocket.send_text(json.dumps({"done": True}))


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.websocket("/trace")
async def trace(websocket: WebSocket, target: str = "google"):
    """V1: Trace to a curated target from the dropdown."""
    await websocket.accept()
    if target not in TARGETS:
        log_event(logging.WARNING, "TRACE", "Invalid trace target requested", target=target)
        await websocket.send_text(json.dumps({"error": "Invalid target"}))
        return
    log_event(logging.INFO, "TRACE", "Trace requested",
              target=target, target_ip=TARGETS[target])
    await run_trace(websocket, TARGETS[target])


@app.websocket("/trace-ip")
async def trace_ip(websocket: WebSocket, ip: str = ""):
    """V2: Trace to a specific IP (the peer's IP from WebRTC)."""
    await websocket.accept()
    if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', ip):
        log_event(logging.WARNING, "TRACE", "Invalid IP format for trace-ip", ip=ip)
        await websocket.send_text(json.dumps({"error": "Invalid IP format"}))
        return
    if not is_public_ip(ip):
        log_event(logging.WARNING, "TRACE", "Refused to trace a private IP", ip=ip)
        await websocket.send_text(json.dumps({"error": "Cannot trace private IP"}))
        return
    log_event(logging.INFO, "TRACE", "Trace requested (peer IP)", target_ip=ip)
    await run_trace(websocket, ip)


def _handle_signal_message(data: str, room_id: str | None, role: str, client_ip: str) -> bool:
    """
    Inspects one raw relayed signaling message for logging purposes, and
    intercepts the telemetry bridge so frontend P2P events reach the backend
    logs even though the backend itself never sees the actual file bytes.

    Returns True  → message was fully handled here; do NOT relay to the peer.
                    (Currently: telemetry only.)
    Returns False → relay as normal.
                    (SDP offers/answers, ICE candidates, anything else.)

    Never raises: a malformed/non-JSON payload is logged at WARN and returned
    as False so a logging bug can never break the actual WebRTC handshake.
    """
    try:
        msg = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        log_event(logging.WARNING, "SIGNALING", "Received non-JSON signaling message",
                  room_id=room_id, client_ip=client_ip, role=role)
        return False

    msg_type = msg.get("type")

    # ── Telemetry bridge ──────────────────────────────────────────────────────
    # The frontend sends { type: "telemetry", event: "file_shared"|"file_downloaded", ... }
    # over the existing signaling WebSocket. We log it here and return True so
    # it is NOT forwarded to the other peer (it's for backend observability only).
    if msg_type == "telemetry":
        event    = msg.get("event", "unknown")
        metadata = {k: v for k, v in msg.items() if k not in ("type", "event")}
        log_event(logging.INFO, "TELEMETRY", f"Frontend telemetry: {event}",
                  room_id=room_id, client_ip=client_ip, event=event, **metadata)
        return True   # consumed — do not relay

    # ── WebRTC SDP / ICE ─────────────────────────────────────────────────────
    # Log at DEBUG (file-only) so SDP blobs don't spam the console.
    if msg_type in ("offer", "answer", "ice"):
        log_event(logging.DEBUG, "SIGNALING", f"Relaying {msg_type}",
                  room_id=room_id, client_ip=client_ip, role=role)
        return False

    # ── Anything else ─────────────────────────────────────────────────────────
    log_event(logging.DEBUG, "SIGNALING", "Relaying signaling message",
              room_id=room_id, client_ip=client_ip, role=role, msg_type=msg_type)
    return False


@app.websocket("/signal")
async def signal(websocket: WebSocket, room: str = None, role: str = "host"):
    """
    WebRTC signaling server. Acts as a relay so two browsers can exchange
    connection info (offer/answer/ICE) before going P2P direct.
    """
    await websocket.accept()
    # Behind ngrok/a reverse proxy without forwarded-header support this
    # reflects the proxy hop, not always the original client.
    client_ip    = websocket.client.host if websocket.client else "unknown"
    current_room = None

    try:
        # ── Host path ─────────────────────────────────────────────────────────
        if role == "host":
            code = generate_room_code()
            while code in rooms:
                code = generate_room_code()
            rooms[code] = {"host": websocket, "guest": None, "created_at": time.time()}
            current_room = code
            log_event(logging.INFO, "SIGNALING", "Room created",
                      room_id=code, client_ip=client_ip, role="host")
            await websocket.send_text(json.dumps({"type": "room_created", "room": code}))

            while True:
                data = await websocket.receive_text()
                if _handle_signal_message(data, current_room, "host", client_ip):
                    continue   # telemetry consumed — don't relay
                if current_room in rooms and rooms[current_room]["guest"]:
                    await rooms[current_room]["guest"].send_text(data)

        # ── Guest path ────────────────────────────────────────────────────────
        elif role == "guest":
            if not room:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: no room code provided",
                          client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "No room code provided"})
                )
                return

            room = room.upper()
            if room not in rooms:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: room not found",
                          room_id=room, client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "Room not found. Check the code."})
                )
                return
            if rooms[room]["guest"] is not None:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: room already full",
                          room_id=room, client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "Room is full"})
                )
                return

            rooms[room]["guest"] = websocket
            current_room = room
            log_event(logging.INFO, "SIGNALING", "Guest joined room",
                      room_id=room, client_ip=client_ip, role="guest")

            await rooms[room]["host"].send_text(json.dumps({"type": "guest_joined"}))
            await websocket.send_text(json.dumps({"type": "joined", "room": room}))

            while True:
                data = await websocket.receive_text()
                if _handle_signal_message(data, current_room, "guest", client_ip):
                    continue   # telemetry consumed — don't relay
                if current_room in rooms and rooms[current_room]["host"]:
                    await rooms[current_room]["host"].send_text(data)

    except WebSocketDisconnect:
        if current_room and current_room in rooms:
            # Notify the other peer before tearing down the room.
            other = rooms[current_room].get("guest" if role == "host" else "host")
            if other:
                try:
                    await other.send_text(json.dumps({"type": "peer_disconnected"}))
                except Exception:
                    pass
            del rooms[current_room]
            log_event(logging.INFO, "SIGNALING", "Peer disconnected; room closed",
                      room_id=current_room, client_ip=client_ip, role=role)

    except Exception as e:
        log_event(logging.ERROR, "SIGNALING", "Unhandled exception in signaling connection",
                  room_id=current_room, client_ip=client_ip, error=str(e))
        if current_room and current_room in rooms:
            del rooms[current_room]


app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    return FileResponse("frontend/dist/index.html")