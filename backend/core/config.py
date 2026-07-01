"""
core/config.py
==============
Central configuration — all constants, environment-driven values, and
lookup tables live here so every other module imports from one place.
Nothing in this file should perform I/O or import heavy dependencies.
"""

from pathlib import Path

# ── GeoIP database path ───────────────────────────────────────────────────────
GEOIP_DB = "backend/GeoLite2-City.mmdb"

if not Path(GEOIP_DB).exists():
    raise RuntimeError(
        "GeoLite2-City.mmdb not found at backend/GeoLite2-City.mmdb. "
        "Download it free from https://dev.maxmind.com and place it there. "
        "See README.md for setup instructions."
    )

# ── Curated trace targets (V1 dropdown) ──────────────────────────────────────
TARGETS: dict[str, str] = {
    "google":     "8.8.8.8",
    "cloudflare": "1.1.1.1",
    "london":     "151.101.0.81",
    "tokyo":      "54.65.0.1",
    "new-york":   "151.101.112.81",
}

# ── Signaling / room lifecycle ────────────────────────────────────────────────
ROOM_TTL_SECONDS: int         = 10 * 60
CLEANUP_INTERVAL_SECONDS: int = 60

# ── WebRTC / file-transfer chunk sizes ───────────────────────────────────────
CHUNK_SIZE: int   = 16 * 1024
BUFFER_LIMIT: int =  1 * 1024 * 1024