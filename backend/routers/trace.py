"""
routers/trace.py
================
WebSocket endpoints for live traceroute streaming.

Endpoints
---------
GET /trace?target=<id>
    V1 — trace to a curated destination from the TARGETS dict.
    Validates that *target* is a known key; rejects unknown values.

GET /trace-ip?ip=<address>
    V2 — trace to a raw IPv4 address (the peer's discovered IP from WebRTC).
    Validates format and rejects private/reserved addresses.

Both endpoints delegate the actual traceroute execution and hop streaming
to ``services.tracer.run_trace()``.
"""

import json
import logging
import re

from fastapi import APIRouter, WebSocket

from backend.core.config  import TARGETS
from backend.core.logging import log_event
from backend.services.tracer import run_trace, is_public_ip

router = APIRouter()


@router.websocket("/trace")
async def trace(websocket: WebSocket, target: str = "google"):
    """
    V1: Trace to a curated target from the frontend dropdown.

    Query params
    ------------
    target : one of the keys in ``core.config.TARGETS``
             (google | cloudflare | london | tokyo | new-york)
    """
    await websocket.accept()
    if target not in TARGETS:
        log_event(logging.WARNING, "TRACE",
                  "Invalid trace target requested", target=target)
        await websocket.send_text(json.dumps({"error": "Invalid target"}))
        return

    log_event(logging.INFO, "TRACE", "Trace requested",
              target=target, target_ip=TARGETS[target])
    await run_trace(websocket, TARGETS[target])


@router.websocket("/trace-ip")
async def trace_ip(websocket: WebSocket, ip: str = ""):
    """
    V2: Trace to a specific IP address (peer's IP discovered via WebRTC).

    Query params
    ------------
    ip : IPv4 address string — must be a valid, globally-routable address.
    """
    await websocket.accept()

    if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', ip):
        log_event(logging.WARNING, "TRACE",
                  "Invalid IP format for trace-ip", ip=ip)
        await websocket.send_text(json.dumps({"error": "Invalid IP format"}))
        return

    if not is_public_ip(ip):
        log_event(logging.WARNING, "TRACE",
                  "Refused to trace a private IP", ip=ip)
        await websocket.send_text(json.dumps({"error": "Cannot trace private IP"}))
        return

    log_event(logging.INFO, "TRACE", "Trace requested (peer IP)", target_ip=ip)
    await run_trace(websocket, ip)
