from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import re
import json
import geoip2.database

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Path to your MaxMind database
GEOIP_DB = "backend/GeoLite2-City.mmdb"

# Allowed targets — backend only accepts these IDs, never raw user input
TARGETS = {
    "google":     "8.8.8.8",
    "cloudflare": "1.1.1.1",
    "london":     "151.101.0.81",
    "tokyo":      "54.65.0.1",
    "new-york":   "151.101.112.81",
}

def parse_ip_from_line(line: str):
    """
    Extract the first public IP from a traceroute line.
    Skips private IPs (10.x, 192.168.x, 172.16-31.x) and timeout lines.
    """
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    for ip in ips:
        parts = ip.split(".")
        a, b = int(parts[0]), int(parts[1])
        if a == 10:
            continue
        if a == 172 and 16 <= b <= 31:
            continue
        if a == 192 and b == 168:
            continue
        return ip
    return None

def geolocate(ip: str, reader):
    """Look up an IP in MaxMind. Returns city/lat/lng or None."""
    try:
        response = reader.city(ip)
        lat = response.location.latitude
        lng = response.location.longitude
        city = response.city.name or "Unknown city"
        country = response.country.name or "Unknown country"
        if lat is None or lng is None:
            return None
        return {"city": f"{city}, {country}", "lat": lat, "lng": lng}
    except Exception:
        return None

@app.websocket("/trace")
async def trace(websocket: WebSocket, target: str = "google"):
    await websocket.accept()

    # Security: only allow known target IDs
    if target not in TARGETS:
        await websocket.send_text(json.dumps({"error": "Invalid target"}))
        await websocket.close()
        return

    target_ip = TARGETS[target]
    print(f"Starting trace to {target} ({target_ip})")

    process = await asyncio.create_subprocess_exec(
        "traceroute", "-n", "-m", "20", target_ip,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    hop_number = 0

    with geoip2.database.Reader(GEOIP_DB) as reader:
        async for raw_line in process.stdout:
            line = raw_line.decode("utf-8").strip()
            print(f"  traceroute: {line}")

            if line.startswith("traceroute"):
                continue

            hop_number += 1
            ip = parse_ip_from_line(line)

            if ip is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number,
                    "city": "Unknown (timeout)",
                    "lat": None,
                    "lng": None,
                    "timeout": True,
                }))
                continue

            geo = geolocate(ip, reader)

            if geo is None:
                await websocket.send_text(json.dumps({
                    "hop": hop_number,
                    "city": f"{ip} (no location data)",
                    "lat": None,
                    "lng": None,
                    "timeout": True,
                }))
                continue

            payload = {
                "hop": hop_number,
                "ip": ip,
                "city": geo["city"],
                "lat": geo["lat"],
                "lng": geo["lng"],
                "timeout": False,
            }
            print(f"  → Hop {hop_number}: {ip} → {geo['city']}")
            await websocket.send_text(json.dumps(payload))

    await process.wait()
    await websocket.send_text(json.dumps({"done": True}))
    print("Trace complete.")