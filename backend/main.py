"""
main.py
=======
Entry point for the Packet Path Visualizer backend.

Responsibilities (and nothing more)
------------------------------------
- Define the FastAPI application instance.
- Register the lifespan context manager (startup / shutdown hooks).
- Attach CORS and ngrok-bypass middleware.
- Include all routers.
- Mount static files and the SPA fallback route.

All business logic lives in the modules under ``core/``, ``services/``,
``signaling/``, and ``routers/``.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from backend.core.logging    import log_event, stop_listener, LOG_FILE
from backend.signaling.rooms import cleanup_stale_rooms
from backend.routers         import trace, signal, cables


# ── Application lifespan ──────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    log_event(logging.INFO, "STARTUP",
              "Packet Path Visualizer backend started", log_file=LOG_FILE)
    asyncio.create_task(cleanup_stale_rooms())
    yield
    # Flush the non-blocking log queue before the process exits so the
    # final few records aren't dropped mid-write.
    stop_listener()


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(lifespan=lifespan)


# ── CORS — open for local + ngrok dev ────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Ngrok browser-warning bypass ─────────────────────────────────────────────
class NgrokHeaderMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["ngrok-skip-browser-warning"] = "true"
        return response


app.add_middleware(NgrokHeaderMiddleware)


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(trace.router)
app.include_router(signal.router)
app.include_router(cables.router)

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


# ── Static files + SPA fallback ───────────────────────────────────────────────
app.mount("/assets", StaticFiles(directory="frontend/dist/assets"), name="assets")


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    return FileResponse("frontend/dist/index.html")
