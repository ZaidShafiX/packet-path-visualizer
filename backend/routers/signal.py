"""
routers/signal.py
=================
WebRTC signaling relay over WebSocket.

Acts as a rendezvous point so two browsers can exchange SDP offer/answer
and ICE candidates before establishing a direct P2P connection.  Once the
WebRTC handshake completes, the data channel bypasses this server entirely.

Endpoint
--------
WS /signal?role=host
    Creates a new room, returns ``{"type": "room_created", "room": "<code>"}``,
    then relays any messages sent by the host to the guest.

WS /signal?role=guest&room=<code>
    Joins an existing room, notifies the host, then relays guest messages
    to the host.

Message interception
--------------------
Before each relay, ``signaling.telemetry._handle_signal_message()`` inspects
the payload.  Telemetry frames are consumed (logged) and NOT forwarded.
All other frames (offer / answer / ICE / custom) are forwarded as-is.

Room cleanup
------------
On disconnect, the room is deleted and the remaining peer receives a
``{"type": "peer_disconnected"}`` notification.
"""

import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.core.logging      import log_event
from backend.signaling.rooms   import rooms, generate_room_code
from backend.signaling.telemetry import _handle_signal_message

router = APIRouter()


@router.websocket("/signal")
async def signal(
    websocket: WebSocket,
    room: str  = None,
    role: str  = "host",
):
    """
    WebRTC signaling server — relay-only, no media.

    Query params
    ------------
    role : "host" | "guest"
    room : room code (required when role == "guest")
    """
    await websocket.accept()

    # Behind ngrok / a reverse proxy without forwarded-header support,
    # this reflects the proxy hop rather than the real client IP.
    client_ip    = websocket.client.host if websocket.client else "unknown"
    current_room = None

    try:
        # ── Host path ─────────────────────────────────────────────────────────
        if role == "host":
            code = generate_room_code()
            while code in rooms:
                code = generate_room_code()

            rooms[code] = {"host": websocket, "guest": None, "created_at": time.time()}
            current_room = code

            log_event(logging.INFO, "SIGNALING", "Room created",
                      room_id=code, client_ip=client_ip, role="host")
            await websocket.send_text(json.dumps({"type": "room_created", "room": code}))

            while True:
                data = await websocket.receive_text()
                if _handle_signal_message(data, current_room, "host", client_ip):
                    continue   # telemetry consumed — don't relay
                if current_room in rooms and rooms[current_room]["guest"]:
                    await rooms[current_room]["guest"].send_text(data)

        # ── Guest path ────────────────────────────────────────────────────────
        elif role == "guest":
            if not room:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: no room code provided",
                          client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "No room code provided"})
                )
                return

            room = room.upper()

            if room not in rooms:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: room not found",
                          room_id=room, client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "Room not found. Check the code."})
                )
                return

            if rooms[room]["guest"] is not None:
                log_event(logging.WARNING, "SIGNALING",
                          "Guest connect rejected: room already full",
                          room_id=room, client_ip=client_ip)
                await websocket.send_text(
                    json.dumps({"type": "error", "message": "Room is full"})
                )
                return

            rooms[room]["guest"] = websocket
            current_room = room

            log_event(logging.INFO, "SIGNALING", "Guest joined room",
                      room_id=room, client_ip=client_ip, role="guest")

            await rooms[room]["host"].send_text(json.dumps({"type": "guest_joined"}))
            await websocket.send_text(json.dumps({"type": "joined", "room": room}))

            while True:
                data = await websocket.receive_text()
                if _handle_signal_message(data, current_room, "guest", client_ip):
                    continue   # telemetry consumed — don't relay
                if current_room in rooms and rooms[current_room]["host"]:
                    await rooms[current_room]["host"].send_text(data)

    except WebSocketDisconnect:
        if current_room and current_room in rooms:
            # Notify the surviving peer before tearing down the room.
            other = rooms[current_room].get("guest" if role == "host" else "host")
            if other:
                try:
                    await other.send_text(json.dumps({"type": "peer_disconnected"}))
                except Exception:
                    pass
            del rooms[current_room]
            log_event(logging.INFO, "SIGNALING", "Peer disconnected; room closed",
                      room_id=current_room, client_ip=client_ip, role=role)

    except Exception as e:
        log_event(logging.ERROR, "SIGNALING",
                  "Unhandled exception in signaling connection",
                  room_id=current_room, client_ip=client_ip, error=str(e))
        if current_room and current_room in rooms:
            del rooms[current_room]
