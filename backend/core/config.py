"""
core/config.py
==============
Central configuration — all constants, environment-driven values, and
lookup tables live here so every other module imports from one place.
Nothing in this file should perform I/O or import heavy dependencies.
"""

# ── GeoIP database path ───────────────────────────────────────────────────────
GEOIP_DB = "backend/GeoLite2-City.mmdb"

# ── Curated trace targets (V1 dropdown) ──────────────────────────────────────
TARGETS: dict[str, str] = {
    "google":     "8.8.8.8",
    "cloudflare": "1.1.1.1",
    "london":     "151.101.0.81",
    "tokyo":      "54.65.0.1",
    "new-york":   "151.101.112.81",
}

# ── Signaling / room lifecycle ────────────────────────────────────────────────
# Rooms older than ROOM_TTL_SECONDS are reaped even without a clean disconnect
# (covers crashed tabs, lost network, closed laptops).
ROOM_TTL_SECONDS: int      = 10 * 60   # 10 minutes
CLEANUP_INTERVAL_SECONDS: int = 60

# ── WebRTC / file-transfer chunk sizes ───────────────────────────────────────
# Kept here for reference; the actual chunking lives in the frontend hook,
# but documenting them alongside the backend constants is useful.
CHUNK_SIZE: int   = 16 * 1024        # 16 KB per DataChannel message
BUFFER_LIMIT: int =  1 * 1024 * 1024 # pause sending above 1 MB buffered
