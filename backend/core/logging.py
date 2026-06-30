"""
core/logging.py
===============
Non-blocking structured logging for Packet Path Visualizer.

Design
------
- Every call site uses log_event() which only touches a QueueHandler —
  essentially instant, never blocks on disk I/O.
- A single background thread (QueueListener) owns the real FileHandler /
  StreamHandler and does all blocking writes off the asyncio event loop,
  so a slow disk can never stall a live traceroute or WebRTC signaling
  connection.
- Log lines follow the format:
    [TIMESTAMP] [LEVEL] [COMPONENT] - Message | Metadata: {JSON}

Usage
-----
    from backend.core.logging import log_event
    import logging

    log_event(logging.INFO, "TRACE", "Hop discovered", hop=3, ip="1.2.3.4")
"""

import json
import logging
import logging.handlers
import os
import queue
from datetime import datetime

# ── Log file setup ────────────────────────────────────────────────────────────
LOG_DIR  = "logs"
os.makedirs(LOG_DIR, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, f"app_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")


# ── Custom formatter ──────────────────────────────────────────────────────────
class PacketVisualizerFormatter(logging.Formatter):
    """
    Formats each record as:
        [TIMESTAMP] [LEVEL] [COMPONENT] - Message | Metadata: {JSON_STRING}

    COMPONENT and metadata are supplied per-call via log_event()'s ``extra=``
    dict; both fall back to sane defaults if a raw logger.* call bypasses it.
    """

    def format(self, record: logging.LogRecord) -> str:
        timestamp     = self.formatTime(record, "%Y-%m-%d %H:%M:%S")
        component     = getattr(record, "component", "GENERAL")
        metadata      = getattr(record, "metadata", None) or {}
        metadata_json = json.dumps(metadata, default=str)
        return (
            f"[{timestamp}] [{record.levelname}] [{component}] - "
            f"{record.getMessage()} | Metadata: {metadata_json}"
        )


# ── Queue + listener (module-level singletons) ────────────────────────────────
_log_queue     = queue.Queue(-1)
_queue_handler = logging.handlers.QueueHandler(_log_queue)

logger = logging.getLogger("packet_visualizer")
logger.setLevel(logging.DEBUG)
logger.addHandler(_queue_handler)
logger.propagate = False

_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setLevel(logging.DEBUG)        # everything → file
_file_handler.setFormatter(PacketVisualizerFormatter())

_stream_handler = logging.StreamHandler()
_stream_handler.setLevel(logging.INFO)       # console stays quiet; DEBUG is file-only
_stream_handler.setFormatter(PacketVisualizerFormatter())

_queue_listener = logging.handlers.QueueListener(
    _log_queue, _file_handler, _stream_handler, respect_handler_level=True
)
_queue_listener.start()


# ── Public API ────────────────────────────────────────────────────────────────
def log_event(level: int, component: str, message: str, **metadata) -> None:
    """
    Structured logging helper used everywhere instead of print().

    Parameters
    ----------
    level     : logging constant, e.g. logging.INFO
    component : uppercase tag, e.g. "TRACE", "SIGNALING", "ENRICHMENT"
    message   : human-readable description
    **metadata: arbitrary key/value pairs serialised as JSON on the log line
    """
    logger.log(level, message, extra={"component": component, "metadata": metadata})


def stop_listener() -> None:
    """
    Flush and shut down the background log listener.
    Called from the FastAPI lifespan shutdown hook so the final records
    aren't dropped mid-write when the process exits.
    """
    _queue_listener.stop()
