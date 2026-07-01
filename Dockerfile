# =============================================================================
# Packet Path Visualizer — Multi-stage Dockerfile
# =============================================================================
#
# Stages
# ------
#   1. frontend-deps   — install Node modules (cached layer)
#   2. frontend-build  — vite build → /app/frontend/dist
#   3. backend         — slim Python runtime with the built SPA baked in
#
# The final image contains zero Node/npm tooling; only what uvicorn needs.
# =============================================================================


# ── Stage 1: install frontend dependencies ────────────────────────────────────
FROM node:22-alpine AS frontend-deps

WORKDIR /app/frontend

# Copy manifests first so this layer is only invalidated when deps change,
# not on every source file edit.
COPY frontend/package.json frontend/package-lock.json* ./

RUN npm ci --frozen-lockfile


# ── Stage 2: build the React/Vite SPA ────────────────────────────────────────
FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend

# Reuse the installed node_modules from the previous stage.
COPY --from=frontend-deps /app/frontend/node_modules ./node_modules

# Copy all frontend source.
COPY frontend/ ./

RUN npm run build
# Output → /app/frontend/dist


# ── Stage 3: production Python runtime ───────────────────────────────────────
FROM python:3.12-slim AS backend

# ── System packages ───────────────────────────────────────────────────────────
# traceroute   — required by services/tracer.py (subprocess call)
# curl         — lightweight health-check probe
# No build tools needed: all Python deps are pure-Python wheels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      traceroute \
      curl \
      libcap2-bin \
 && setcap cap_net_raw+ep "$(readlink -f "$(command -v traceroute)")" \
 && apt-get purge -y libcap2-bin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python dependencies ───────────────────────────────────────────────────────
# Copy requirements before source so pip layer is cached independently.
COPY backend/requirements.txt ./backend/requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r backend/requirements.txt

# ── Backend source ────────────────────────────────────────────────────────────
COPY backend/ ./backend/

# ── Pre-built frontend (from stage 2) ────────────────────────────────────────
# main.py mounts  /app/frontend/dist/assets  and serves  /app/frontend/dist/index.html
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# ── Runtime directories ───────────────────────────────────────────────────────
# logs/ is written at runtime; creating it here avoids a root-owned dir.
RUN mkdir -p logs \
 && addgroup --system ppv \
 && adduser  --system --ingroup ppv ppv \
 && chown -R ppv:ppv /app

USER ppv

# ── Expose & run ──────────────────────────────────────────────────────────────
EXPOSE 8000

# --workers 1  keeps the in-process rooms dict consistent across requests.
# For horizontal scaling, replace with Redis pub/sub and raise workers.
CMD ["uvicorn", "backend.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--log-level", "warning"]