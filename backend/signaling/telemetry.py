"""
signaling/telemetry.py
======================
Signaling message inspection and telemetry bridge.

The frontend sends observability events (file transfers, etc.) over the
existing /signal WebSocket rather than opening a second connection.  This
module intercepts those ``type: "telemetry"`` frames, logs them, and
returns True so the router knows *not* to forward them to the other peer.

All other frame types (SDP offers/answers, ICE candidates) are logged at
DEBUG level and returned with False so the router relays them normally.

Public API
----------
    handled = _handle_signal_message(data, room_id, role, client_ip)
    # True  → consumed here; do NOT relay to peer
    # False → relay as normal
"""

import json
import logging

from backend.core.logging import log_event


def _handle_signal_message(
    data: str,
    room_id: str | None,
    role: str,
    client_ip: str,
) -> bool:
    """
    Inspect one raw signaling message for logging and telemetry purposes.

    Parameters
    ----------
    data      : raw JSON string received from the WebSocket
    room_id   : current room code (may be None before a room is created)
    role      : "host" or "guest"
    client_ip : originating IP address (may be a proxy hop behind ngrok)

    Returns
    -------
    True  — message fully handled here; router must NOT relay to the peer.
             Currently applies only to ``type: "telemetry"`` frames.
    False — relay to the remote peer as normal.
             Applies to SDP offers/answers, ICE candidates, and anything
             else we don't explicitly consume.

    Never raises: a malformed/non-JSON payload is logged at WARN and
    returned as False so a logging bug can never break a WebRTC handshake.
    """
    try:
        msg = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        log_event(logging.WARNING, "SIGNALING",
                  "Received non-JSON signaling message",
                  room_id=room_id, client_ip=client_ip, role=role)
        return False

    msg_type = msg.get("type")

    # ── Telemetry bridge ──────────────────────────────────────────────────────
    # The frontend sends { type: "telemetry", event: "file_shared"|
    # "file_downloaded", ... } over the signaling WebSocket.  We log it and
    # return True so it is NOT forwarded to the other peer.
    if msg_type == "telemetry":
        event    = msg.get("event", "unknown")
        metadata = {k: v for k, v in msg.items() if k not in ("type", "event")}
        log_event(logging.INFO, "TELEMETRY",
                  f"Frontend telemetry: {event}",
                  room_id=room_id, client_ip=client_ip, event=event, **metadata)
        return True   # consumed — do not relay

    # ── WebRTC SDP / ICE ─────────────────────────────────────────────────────
    # Log at DEBUG (file-only) so SDP blobs don't spam the console.
    if msg_type in ("offer", "answer", "ice"):
        log_event(logging.DEBUG, "SIGNALING", f"Relaying {msg_type}",
                  room_id=room_id, client_ip=client_ip, role=role)
        return False

    # ── Everything else ───────────────────────────────────────────────────────
    log_event(logging.DEBUG, "SIGNALING", "Relaying signaling message",
              room_id=room_id, client_ip=client_ip, role=role, msg_type=msg_type)
    return False
