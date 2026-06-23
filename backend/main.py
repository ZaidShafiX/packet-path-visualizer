from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import re
import json
import random
import string
import geoip2.database

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

GEOIP_DB = "backend/GeoLite2-City.mmdb"

TARGETS = {
    "google":     "8.8.8.8",
    "cloudflare": "1.1.1.1",
    "london":     "151.101.0.81",
    "tokyo":      "54.65.0.1",
    "new-york":   "151.101.112.81",
}

# Signaling rooms: { code: { "host": ws, "guest": ws | None } }
rooms = {}

# ── Helpers ───────────────────────────────────────────────────────────────────

def generate_room_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))

def parse_ip_from_line(line):
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    for ip in ips:
        parts = ip.split(".")
        a, b = int(parts[0]), int(parts[1])
        if a == 10: continue
        if a == 172 and 16 <= b <= 31: continue
        if a == 192 and b == 168: continue
        return ip
    return None

def is_public_ip(ip):
    parts = ip.split(".")
    a, b = int(parts[0]), int(parts[1])
    if a == 10: return False
    if a == 172 and 16 <= b <= 31: return False
    if a == 192 and b == 168: return False
    if a == 127: return False
    return True

def geolocate(ip, reader):
    try:
        r = reader.city(ip)
        lat, lng = r.location.latitude, r.location.longitude
        if lat is None or lng is None: return None
        city    = r.city.name    or "Unknown city"
        country = r.country.name or "Unknown country"
        return {"city": f"{city}, {country}", "lat": lat, "lng": lng}
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
            if ip is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number, "city": "Unknown (timeout)",
                    "lat": None, "lng": None, "timeout": True
                }))
                continue
            geo = geolocate(ip, reader)
            if geo is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number, "city": f"{ip} (no location)",
                    "lat": None, "lng": None, "timeout": True
                }))
                continue
            payload = {
                "hop": hop_number, "ip": ip,
                "city": geo["city"], "lat": geo["lat"], "lng": geo["lng"],
                "timeout": False
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
    # Validate it's a real public IPv4 — never trust raw input
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
            # Create a new room with a unique code
            code = generate_room_code()
            while code in rooms:
                code = generate_room_code()
            rooms[code] = {"host": websocket, "guest": None}
            current_room = code
            print(f"Room {code} created")
            await websocket.send_text(json.dumps({"type": "room_created", "room": code}))

            # Relay everything the host sends → to the guest
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

            # Tell both sides the room is ready
            await rooms[room]["host"].send_text(json.dumps({"type": "guest_joined"}))
            await websocket.send_text(json.dumps({"type": "joined", "room": room}))

            # Relay everything the guest sends → to the host
            while True:
                data = await websocket.receive_text()
                if current_room in rooms and rooms[current_room]["host"]:
                    await rooms[current_room]["host"].send_text(data)

    except WebSocketDisconnect:
        if current_room and current_room in rooms:
            # Notify the other peer that their partner left
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