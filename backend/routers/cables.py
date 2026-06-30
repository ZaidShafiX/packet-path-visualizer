"""
routers/cables.py
=================
REST endpoint that proxies and caches the TeleGeography submarine cable
GeoJSON dataset.

Why proxy?
----------
Fetching the dataset directly from the browser triggers CORS pre-flight
failures against submarinecablemap.com.  Proxying through the backend
avoids that entirely and lets us cache the ~3 MB payload in process
memory so repeat page loads don't re-fetch it from the remote.

Endpoint
--------
GET /api/cables
    Returns the full cable-geo.json as JSON.
    On first call, fetches from the upstream URL and populates the cache.
    Subsequent calls return the cached value without a network round-trip.
"""

import httpx
from fastapi import APIRouter

router = APIRouter()

# Module-level cache — populated on first request, never expires during
# the process lifetime.  A restart resets it, which is intentional; the
# dataset changes infrequently and the upstream fetch is fast.
_cable_cache = None


@router.get("/api/cables")
async def get_cables():
    """
    Return the TeleGeography submarine cable GeoJSON.

    Fetches from ``submarinecablemap.com`` on first call; subsequent
    calls return the in-memory cached response.
    """
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
