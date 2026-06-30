"""
services/dns.py
===============
Reverse DNS (PTR record) lookup for traceroute hop enrichment.

Design
------
- socket.gethostbyaddr is blocking, so it executes inside asyncio.to_thread.
- asyncio.wait_for enforces a hard 2-second ceiling so a slow resolver can
  never stall the trace stream.

Public API
----------
    hostname = await reverse_dns_lookup("8.8.8.8")
    # → "dns.google"  or  None
"""

import asyncio
import logging
import socket

from backend.core.logging import log_event


async def reverse_dns_lookup(ip: str) -> str | None:
    """
    Resolve the PTR record for *ip*.

    Parameters
    ----------
    ip : IPv4 address string

    Returns
    -------
    Hostname string (e.g. ``"dns.google"``) or None if there is no PTR
    record, the lookup fails, or it exceeds the 2-second timeout.
    """
    try:
        hostname, _, _ = await asyncio.wait_for(
            asyncio.to_thread(socket.gethostbyaddr, ip), timeout=2.0
        )
        log_event(logging.DEBUG, "ENRICHMENT", "Reverse DNS lookup succeeded",
                  ip=ip, hostname=hostname)
        return hostname
    except Exception as e:
        log_event(logging.WARNING, "ENRICHMENT", "Reverse DNS lookup failed",
                  ip=ip, error=str(e))
        return None
