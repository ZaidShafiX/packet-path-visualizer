"""
services/asn.py
===============
ASN / organisation lookup for traceroute hop enrichment.

History
-------
Originally targeted api.bgpview.io, which was permanently shut down on
2025-11-26.  Migrated to ip-api.com's ``as``/``org`` fields — the same
key-less, free API already used by the geolocation fallback, so no new
dependency or new failure mode was introduced.

Limitation
----------
ip-api.com does not expose the announced CIDR prefix, so ``prefix`` in
the returned dict is always None.

Public API
----------
    info = await asn_bgp_lookup("8.8.8.8")
    # → {"asn": 15169, "org": "Google LLC", "prefix": None}
    # → None on any failure
"""

import asyncio
import json
import logging
import urllib.request

from backend.core.logging import log_event


# ── Blocking half (runs inside asyncio.to_thread) ────────────────────────────
def _asn_lookup_sync(ip: str) -> dict:
    """Fetch AS and org fields from ip-api.com synchronously."""
    url = f"http://ip-api.com/json/{ip}?fields=status,as,org"
    with urllib.request.urlopen(url, timeout=2) as resp:
        return json.loads(resp.read().decode())


# ── Async public function ─────────────────────────────────────────────────────
async def asn_bgp_lookup(ip: str) -> dict | None:
    """
    Look up ASN and organisation for *ip* via ip-api.com.

    Parameters
    ----------
    ip : IPv4 address string

    Returns
    -------
    dict with keys:
        ``asn``    – integer ASN, or None
        ``org``    – organisation name string, or None
        ``prefix`` – always None (ip-api.com doesn't provide CIDR)
    or None if the lookup fails or returns no usable data.
    """
    try:
        data = await asyncio.wait_for(
            asyncio.to_thread(_asn_lookup_sync, ip), timeout=2.0
        )
        if data.get("status") != "success":
            log_event(logging.WARNING, "ENRICHMENT",
                      "ASN lookup returned non-success status",
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
            log_event(logging.WARNING, "ENRICHMENT",
                      "ASN lookup returned no usable data", ip=ip)
            return None

        log_event(logging.DEBUG, "ENRICHMENT", "ASN lookup succeeded",
                  ip=ip, asn=asn, org=org)
        return {"asn": asn, "org": org, "prefix": None}

    except Exception as e:
        log_event(logging.WARNING, "ENRICHMENT", "ASN lookup failed",
                  ip=ip, error=str(e))
        return None
