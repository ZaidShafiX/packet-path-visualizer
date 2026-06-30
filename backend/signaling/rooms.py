"""
signaling/rooms.py
==================
In-memory room registry for WebRTC signaling.

Structure
---------
    rooms: dict[str, RoomEntry]

    RoomEntry = {
        "host":       WebSocket | None,
        "guest":      WebSocket | None,
        "created_at": float,           # time.time()
    }

Public API
----------
    generate_room_code() -> str
    cleanup_stale_rooms() -> None  (async background task, never returns)
"""

import asyncio
import logging
import random
import string
import time

from backend.core.config  import ROOM_TTL_SECONDS, CLEANUP_INTERVAL_SECONDS
from backend.core.logging import log_event


# ── Shared room registry ──────────────────────────────────────────────────────
# Mutated by the /signal router; read here by the cleanup task.
rooms: dict = {}


# ── Helpers ───────────────────────────────────────────────────────────────────

def generate_room_code() -> str:
    """Return a random 6-character alphanumeric room code (upper-case)."""
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


# ── Background cleanup ────────────────────────────────────────────────────────

async def cleanup_stale_rooms() -> None:
    """
    Periodic background task: remove rooms that have outlived their TTL.

    Rooms that never received a clean WebSocket close frame (crashed tabs,
    lost network, closed laptops) are reaped here after ROOM_TTL_SECONDS.
    This coroutine loops indefinitely and is intended to run as an
    asyncio task for the lifetime of the application.
    """
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        now   = time.time()
        stale = [
            code for code, r in rooms.items()
            if now - r["created_at"] > ROOM_TTL_SECONDS
        ]
        for code in stale:
            log_event(logging.INFO, "SIGNALING",
                      "Room expired and was removed",
                      room_id=code, reason="ttl_expired")
            del rooms[code]
