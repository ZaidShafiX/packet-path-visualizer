"""
services/geolocation.py
=======================
IP geolocation service with a two-tier fallback chain.

Primary  : MaxMind GeoLite2-City local binary database (instant, offline)
Secondary: ip-api.com live JSON API (covers IPs MaxMind misses — backbone
           routers, anycast addresses, etc.)

Both run inside asyncio.to_thread so they never block the event loop.

Public API
----------
    geo = await get_geolocation(ip, reader)
    # → {"city": "London, United Kingdom [ISP]", "lat": 51.5, "lng": -0.12}
    # → None  if neither source could resolve the IP
"""

import asyncio
import json
import urllib.request


# ── MaxMind (synchronous) ─────────────────────────────────────────────────────
def geolocate(ip: str, reader) -> dict | None:
    """
    Try to geolocate *ip* using an already-open GeoLite2 database reader.

    Parameters
    ----------
    ip     : IPv4 address string
    reader : open geoip2.database.Reader instance (caller manages lifecycle)

    Returns
    -------
    dict with keys ``city``, ``lat``, ``lng``, or None on any failure.
    """
    try:
        r   = reader.city(ip)
        lat = r.location.latitude
        lng = r.location.longitude
        if lat is None or lng is None:
            return None
        city    = r.city.name    or "Unknown city"
        country = r.country.name or "Unknown country"
        return {"city": f"{city}, {country}", "lat": lat, "lng": lng}
    except Exception:
        return None


# ── ip-api.com fallback (blocking — runs in thread) ──────────────────────────
def fallback_geolocate(ip: str) -> dict | None:
    """
    Fallback geolocation via ip-api.com for IPs MaxMind can't resolve.

    Runs synchronously; callers should wrap with ``asyncio.to_thread``.

    Returns
    -------
    dict with keys ``city``, ``lat``, ``lng`` (city label includes ISP),
    or None on any failure / non-success status.
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


# ── Async wrapper (MaxMind → fallback) ───────────────────────────────────────
async def get_geolocation(ip: str, reader) -> dict | None:
    """
    Async geolocation: tries MaxMind first, then ip-api.com if needed.

    Designed to run inside asyncio.gather() alongside DNS and ASN lookups
    so all three enrichments happen concurrently rather than sequentially.

    Parameters
    ----------
    ip     : IPv4 address string
    reader : open geoip2.database.Reader instance

    Returns
    -------
    dict with keys ``city``, ``lat``, ``lng``, or None.
    """
    geo = geolocate(ip, reader)
    if geo is None:
        geo = await asyncio.to_thread(fallback_geolocate, ip)
    return geo
