"""
services/tracer.py
==================
Core traceroute execution and line-parsing logic.

This module owns:
- ``run_trace()``         — async traceroute driver; streams JSON hop objects
                            over a WebSocket as they are discovered.
- ``parse_ip_from_line()``  — extracts the first IPv4 from a traceroute line.
- ``parse_rtt_from_line()`` — averages the RTT values on a traceroute line.

Each hop is classified into one of four states before transmission:

    TIMEOUT   — no IP in the line (all probes timed out, shown as ``*``)
    PRIVATE   — RFC-1918 / RFC-6598 (CGNAT) / reserved address
    NO GEO    — public IP but neither MaxMind nor ip-api could locate it
    OK        — public IP with coordinates

For public (OK / NO GEO) hops, geolocation, reverse DNS, and ASN lookup
run concurrently via asyncio.gather() to minimise per-hop latency.
"""

import asyncio
import ipaddress
import json
import logging
import re

import geoip2.database

from backend.core.config  import GEOIP_DB
from backend.core.logging import log_event
from backend.services.asn         import asn_bgp_lookup
from backend.services.dns         import reverse_dns_lookup
from backend.services.geolocation import get_geolocation


# ── Parsing helpers ───────────────────────────────────────────────────────────

def parse_ip_from_line(line: str) -> str | None:
    """
    Extract and return the first IPv4 address found in *line*.

    Returns None when all probes timed out (the line contains only ``*``
    tokens and no IP).
    """
    ips = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
    return ips[0] if ips else None


def parse_rtt_from_line(line: str) -> float | None:
    """
    Average the RTT values printed on a single traceroute line.

    Traceroute sends three probes per hop and prints each result separately,
    e.g.  ``3  8.8.8.8  1.234 ms  1.456 ms  1.789 ms``.
    Some probes may time out (shown as ``*``), leaving fewer than three RTT
    values.  We collect every ``N ms`` token, average them, and round to
    two decimal places.  Returns None if no RTT values are present
    (all-timeout line).
    """
    rtts = re.findall(r'(\d+\.?\d*)\s*ms', line)
    if not rtts:
        return None
    values = [float(r) for r in rtts]
    return round(sum(values) / len(values), 2)


def is_public_ip(ip: str) -> bool:
    """
    Return True only for globally-routable addresses.

    Used by the /trace-ip endpoint to reject private peer IPs before
    handing them to the OS traceroute command.
    """
    parts = ip.split(".")
    a, b  = int(parts[0]), int(parts[1])
    if a == 10:                        return False
    if a == 172 and 16 <= b <= 31:     return False
    if a == 192 and b == 168:          return False
    if a == 127:                       return False
    return True


# ── Main traceroute driver ────────────────────────────────────────────────────

async def run_trace(websocket, target_ip: str) -> None:
    """
    Execute ``traceroute -n -m 20 <target_ip>`` and stream hop data as
    JSON text frames over *websocket*.

    Each frame is one of:
    - A hop object (see field list below)
    - ``{"done": true}`` — sent once after the subprocess exits

    Hop object fields
    -----------------
    hop          : int   — 1-based hop counter
    ip           : str | None
    city         : str
    lat          : float | None
    lng          : float | None
    timeout      : bool
    is_private   : bool
    no_location  : bool
    hostname     : str | None
    asn          : int | None
    org          : str | None
    prefix       : None        (reserved; ip-api.com doesn't expose CIDR)
    lookup_status: "complete" | "partial" | "unavailable" | "skipped"
    rtt          : float | None  (ms, averaged across probes)
    """
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
            rtt = parse_rtt_from_line(line)

            # ── Timeout — no response at all ──────────────────────────────────
            if ip is None:
                log_event(logging.DEBUG, "TRACE",
                          "Hop timed out (no response)", hop=hop_number)
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

            # ── Private / Reserved / CGNAT ────────────────────────────────────
            try:
                addr  = ipaddress.ip_address(ip)
                cgnat = addr in ipaddress.ip_network("100.64.0.0/10")
                if addr.is_private or addr.is_reserved or cgnat:
                    log_event(logging.DEBUG, "TRACE",
                              "Private/reserved IP hop discovered",
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

            # ── Public IP — enrich concurrently ───────────────────────────────
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
