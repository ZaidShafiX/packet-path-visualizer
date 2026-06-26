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

app = FastAPI()

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

# Signaling rooms: { code: { "host": ws, "guest": ws | None } }
rooms = {}

# ── Helpers ───────────────────────────────────────────────────────────────────

def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))

def parse_ip_from_line(line):
    """Extract and return the first IP address found in a traceroute line."""
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    if ips:
        return ips[0]
    return None

def is_public_ip(ip):
    """Used only by /trace-ip endpoint to reject private peer IPs."""
    parts = ip.split(".")
    a, b = int(parts[0]), int(parts[1])
    if a == 10: return False
    if a == 172 and 16 <= b <= 31: return False
    if a == 192 and b == 168: return False
    if a == 127: return False
    return True

def geolocate(ip, reader):
    """Try to geolocate an IP using the local MaxMind GeoLite2 database."""
    try:
        r = reader.city(ip)
        lat, lng = r.location.latitude, r.location.longitude
        if lat is None or lng is None: return None
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
        city    = data.get("city", "Unknown")
        country = data.get("country", "Unknown")
        isp     = data.get("isp", "")
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
            if line.startswith("traceroute"): continue
            hop_number += 1

            ip = parse_ip_from_line(line)

            # ── Timeout / no response ─────────────────────────────────────────
            if ip is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number,
                    "city": "Unknown (timeout)",
                    "lat": None, "lng": None,
                    "timeout": True, "is_private": False, "no_location": False
                }))
                continue

            # ── Private / Reserved / CGNAT check ─────────────────────────────
            try:
                addr   = ipaddress.ip_address(ip)
                cgnat  = addr in ipaddress.ip_network("100.64.0.0/10")
                if addr.is_private or addr.is_reserved or cgnat:
                    await websocket.send_text(json.dumps({
                        "hop": hop_number, "ip": ip,
                        "city": "Local / ISP Network",
                        "lat": None, "lng": None,
                        "timeout": False, "is_private": True, "no_location": False
                    }))
                    continue
            except ValueError:
                pass

            # ── Public IP: MaxMind first, ip-api.com fallback ────────────────
            geo = geolocate(ip, reader)
            if geo is None:
                geo = await asyncio.to_thread(fallback_geolocate, ip)

            if geo is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number, "ip": ip,
                    "city": f"{ip} (no location data)",
                    "lat": None, "lng": None,
                    "timeout": False, "is_private": False, "no_location": True
                }))
                continue

            payload = {
                "hop": hop_number, "ip": ip,
                "city": geo["city"], "lat": geo["lat"], "lng": geo["lng"],
                "timeout": False, "is_private": False, "no_location": False
            }
            print(f"  → Hop {hop_number}: {ip} → {geo['city']}")
            await websocket.send_text(json.dumps(payload))

    await process.wait()
    await websocket.send_text(json.dumps({"done": True}))

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.websocket("/trace")
async def trace(websocket: WebSocket, target: str = "google"):
    """V1: Trace to a curated target from the dropdown."""
    await websocket.accept()
    if target not in TARGETS:
        await websocket.send_text(json.dumps({"error": "Invalid target"}))
        return
    print(f"Tracing to {target} ({TARGETS[target]})")
    await run_trace(websocket, TARGETS[target])

@app.websocket("/trace-ip")
async def trace_ip(websocket: WebSocket, ip: str = ""):
    """V2: Trace to a specific IP (the peer's IP from WebRTC)."""
    await websocket.accept()
    if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', ip):
        await websocket.send_text(json.dumps({"error": "Invalid IP format"}))
        return
    if not is_public_ip(ip):
        await websocket.send_text(json.dumps({"error": "Cannot trace private IP"}))
        return
    print(f"Tracing to peer IP: {ip}")
    await run_trace(websocket, ip)

@app.websocket("/signal")
async def signal(websocket: WebSocket, room: str = None, role: str = "host"):
    """
    WebRTC signaling server. Acts as a relay so two browsers can
    exchange connection info (offer/answer/ICE) before going direct.
    """
    await websocket.accept()
    current_room = None

    try:
        if role == "host":
            code = generate_room_code()
            while code in rooms:
                code = generate_room_code()
            rooms[code] = {"host": websocket, "guest": None}
            current_room = code
            print(f"Room {code} created")
            await websocket.send_text(json.dumps({"type": "room_created", "room": code}))

            while True:
                data = await websocket.receive_text()
                if current_room in rooms and rooms[current_room]["guest"]:
                    await rooms[current_room]["guest"].send_text(data)

        elif role == "guest":
            if not room:
                await websocket.send_text(json.dumps({"type": "error", "message": "No room code provided"}))
                return

            room = room.upper()
            if room not in rooms:
                await websocket.send_text(json.dumps({"type": "error", "message": "Room not found. Check the code."}))
                return
            if rooms[room]["guest"] is not None:
                await websocket.send_text(json.dumps({"type": "error", "message": "Room is full"}))
                return

            rooms[room]["guest"] = websocket
            current_room = room
            print(f"Guest joined room {room}")

            await rooms[room]["host"].send_text(json.dumps({"type": "guest_joined"}))
            await websocket.send_text(json.dumps({"type": "joined", "room": room}))

            while True:
                data = await websocket.receive_text()
                if current_room in rooms and rooms[current_room]["host"]:
                    await rooms[current_room]["host"].send_text(data)

    except WebSocketDisconnect:
        if current_room and current_room in rooms:
            other = None
            if role == "host":
                other = rooms[current_room].get("guest")
            else:
                other = rooms[current_room].get("host")
            if other:
                try:
                    await other.send_text(json.dumps({"type": "peer_disconnected"}))
                except Exception:
                    pass
            del rooms[current_room]
            print(f"Room {current_room} closed")

    except Exception as e:
        print(f"Signal error: {e}")
        if current_room and current_room in rooms:
            del rooms[current_room]

app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")

@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    return FileResponse("frontend/dist/index.html")