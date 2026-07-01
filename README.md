# Packet Path Visualizer

**Send a file to a friend anywhere on Earth and watch the network path it travels, drawn live on a 3D globe — submarine cables and all.**

\---

## What it does

When you send data across the internet, it doesn't travel in a straight line. It jumps through a chain of routers — each one passing it along to the next. This project makes that journey visible.

There are two modes:

**Route Trace (V1)** — Pick a destination server (Google DNS, Cloudflare, AWS Tokyo, etc.) and hit Start. The backend runs a real `traceroute` command, classifies and geolocates each router it discovers, and streams the results to the frontend one hop at a time. The globe draws an animated arc between each hop as they arrive — you watch the path build itself in real time, layered over a backdrop of the world's real submarine cable routes.

**Send to Friend (V2)** — You and a friend both open the app. You create a room and share the 6-character code with them. They join. Your browsers negotiate a direct WebRTC peer-to-peer connection. You pick a file — it transfers directly from your browser to theirs, no server in the middle. The moment the connection is established, the backend runs a traceroute to your friend's public IP and draws the route on the globe. Both of you see the same path animate simultaneously, in sync with the file transfer happening in the background.

\---

## How it works

```
Browser (You)                    Backend (Python)              Browser (Friend)
     │                                  │                            │
     │──── WebSocket /signal ──────────►│◄──── WebSocket /signal ────│
     │         (room code exchange,      │        (WebRTC signaling)  │
     │          WebRTC offer/answer/ICE) │                            │
     │                                  │                            │
     │◄────────── RTCDataChannel ────────────────────────────────────►│
     │              (direct P2P, no server)                           │
     │                                  │                            │
     │──── WebSocket /trace-ip ────────►│                            │
     │                                  │ runs traceroute            │
     │                                  │ classifies + geolocates IP │
     │◄──── hop data streamed back ─────│                            │
     │                                  │                            │
     │──── relay hops via DataChannel ───────────────────────────────►│
     │     (friend's globe draws same path)                           │
```

**The backend** runs in Python with FastAPI, without requiring root privileges — `traceroute` is granted the `cap\_net\_raw` Linux capability directly (`setcap cap\_net\_raw+ep`) so it can open raw sockets as a normal user. It's organized into focused modules rather than one large file:

* `core/` — configuration constants and the non-blocking logging setup
* `routers/` — the three FastAPI route handlers (`trace.py`, `signal.py`, `cables.py`), kept thin and delegating to services
* `services/` — the actual traceroute runner, ASN/BGP lookup, reverse DNS, and geolocation logic
* `signaling/` — WebRTC room lifecycle management and the telemetry bridge

It exposes three WebSocket endpoints — `/trace` for curated V1 destinations, `/trace-ip` for tracing to a peer's discovered IP, and `/signal` as the WebRTC signaling relay — plus two small REST endpoints: `/api/cables`, which proxies and caches the submarine cable GeoJSON server-side (avoiding CORS issues with fetching it directly from the browser), and `/healthz`, a lightweight liveness check used by the Docker Compose dev stack so the frontend doesn't have to wait on a live third-party call to confirm the backend is up. It also serves the built frontend as static files so everything runs through one port.

**The frontend** is React, similarly split into components rather than a single `App.jsx`:

* `components/Globe/` — the globe.gl WebGL instance, submarine cable overlay, and the cable-info/transfer-progress UI that sits on top of it
* `components/Sidebar/` — `Sidebar.jsx` (shell + theme toggle) and one view component per screen: `HomeView`, `TraceView`, `TransferView`, `SummaryView`
* `components/shared/` — small reusable pieces (`ProgressBar`, `ThemeToggle`)
* `hooks/` — `useFileTransfer` (WebRTC: ICE negotiation, data channel, chunked sending with backpressure, peer IP discovery via `getStats()`) and `useTraceroute` (trace lifecycle, hop state, globe point/arc updates)
* `services/` — `signaling.js` (WebSocket signaling client) and `telemetry.js` (file-transfer event reporting)
* `utils/summary.js` — trace summary statistics (hop counts, RTT min/max/avg, ASN/country counts, exit point inference)

`App.jsx` wires these together and owns top-level navigation state (`view`) and the active theme.

**Light and dark themes.** The whole sidebar (not the globe — that stays dark in both modes, since it's rendering a night-side Earth texture) switches between a warm charcoal dark mode, and a clean white light mode. The toggle lives top-right in the sidebar header; the choice is applied via a `data-theme` attribute on `<html>`, and every color in `App.css` is a CSS custom property so the two palettes stay in one place rather than scattered `dark:` overrides.

**Geolocation** uses a local MaxMind GeoLite2 binary database as the primary source, with `ip-api.com` as a live fallback for IPs MaxMind can't resolve (e.g. backbone/anycast routers). Each hop is classified into one of four states before being sent to the frontend:

* **OK** — a public IP, successfully geolocated
* **PRIVATE** — an RFC 1918 / CGNAT / reserved address (internal ISP infrastructure that responded, but isn't placeable on a map)
* **NO GEO** — a public IP that responded but couldn't be geolocated by either MaxMind or the fallback
* **TIMEOUT** — no response at all from that hop

**The logging system** uses Python's built-in `logging` module with a non-blocking architecture — a `QueueHandler` pushes log records onto an in-memory queue instantly, and a background `QueueListener` thread handles the actual disk writes, so a slow disk can never stall a live traceroute or WebRTC handshake. Every line follows the format:

```
\[TIMESTAMP] \[LEVEL] \[COMPONENT] - Message | Metadata: {JSON}
```

A new timestamped log file is created per server session under `logs/`. The `logs/` directory is tracked in git (via `.gitkeep`) but all `\*.log` files are gitignored. In the Dockerized production setup, `logs/` is persisted across container restarts via a named Docker volume (`ppv-logs`).

**The telemetry bridge** solves a specific observability gap: since file transfers are pure P2P (the backend never sees the actual bytes), the frontend sends a small JSON message over the already-open signaling WebSocket when a file is sent or received. The backend intercepts these, logs them at `\[INFO]`, and does not relay them to the other peer. This means the log records the full session — room lifecycle, WebRTC handshake, and file transfer events — even though the backend was never in the data path.

\---

## Tech stack

|Layer|Tool|Why|
|-|-|-|
|Backend|Python + FastAPI|Async WebSocket support, runs system commands, modular routers/services|
|Geolocation|MaxMind GeoLite2 + ip-api.com fallback|Local binary DB for instant lookups, live API for what MaxMind misses|
|Frontend|React + Vite|Component model, fast dev server|
|3D Globe|globe.gl|WebGL rendering, geodesic arcs, atmosphere, path overlays|
|Submarine cables|submarinecablemap.com (TeleGeography) GeoJSON|Real-world cable routes as a reference layer, proxied through the backend|
|P2P Transfer|WebRTC RTCDataChannel|Direct browser-to-browser, no server relay for data|
|NAT Traversal|STUN + TURN (openrelay)|Handles strict firewalls and symmetric NAT|
|Theming|CSS custom properties + `data-theme` attribute|Single source of truth for dark/light palettes, no per-component overrides|
|Logging|Python built-in `logging` + QueueListener|Non-blocking file logging, one timestamped file per session|
|Containerization|Docker + Docker Compose|Reproducible builds, isolated raw-socket capability grant, prod/dev profiles|
|Dev tunneling|ngrok|Exposes localhost backend for remote testing; see Setup for install/signup|

\---

## Setup

### Prerequisites

**This project requires Linux — either a native Linux machine, WSL2 on Windows, or macOS.** It will not run on Windows natively (outside a container or WSL). This is a hard requirement whether you run it directly or via Docker: the backend shells out to the system `traceroute` command, which relies on raw socket access (`cap\_net\_raw`) only available on Linux.

**If you're on Windows, use WSL2.** Two important notes if you go this route:

1. **Prefer running Docker as a native Linux engine *inside* WSL2, not through Docker Desktop's WSL2 integration.** Docker Desktop runs its Linux engine inside its own separate hidden VM, which adds an extra layer of NAT between your containers and the real network. That extra NAT hop reliably breaks `traceroute`'s ICMP replies (you'll see every hop past your own gateway time out). Installing Docker Engine directly inside your WSL2 distro avoids this entirely — see [Docker installation](#docker-installation-inside-wsl2-recommended-for-windows-users) below.
2. **Some WSL2 setups resolve common package mirrors (e.g. `deb.debian.org`, npm registry) to IPv6-only addresses that WSL2 can't actually route to**, which causes `apt-get`/`npm ci` to hang for a very long time inside Docker builds instead of failing fast. If a build seems stuck on a package install step for more than a couple of minutes, jump to [Troubleshooting: WSL2 IPv6 hangs](#wsl2-builds-hang-on-apt-get--npm-ci) below.

macOS and native Linux work without any of the above caveats.

**ngrok is only required if you want to share the app with someone outside your own network** (the README's "For remote access" and "different networks entirely" sections below). It's not needed for local use or same-LAN sharing.

1. Sign up for a free account at [ngrok.com](https://ngrok.com) — no credit card required for the free tier.
2. Install the CLI:

```bash
   # Linux / WSL2 (apt)
   curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc \\
     | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \\
     \&\& echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \\
     | sudo tee /etc/apt/sources.list.d/ngrok.list \\
     \&\& sudo apt update \&\& sudo apt install ngrok
   ```

   (macOS: `brew install ngrok/ngrok/ngrok`. Other platforms: download directly from [ngrok.com/download](https://ngrok.com/download).)

3. From your ngrok dashboard, copy your personal authtoken, then connect the CLI to your account (one-time step):

   ```bash
   ngrok config add-authtoken <your-token-here>
   ```

4. Confirm it works:

   ```bash
   ngrok http 8000
   ```

   You should see a forwarding URL like `https://xxxx-xx-xx-xx-xx.ngrok-free.app` — that's the link you'd share externally. `Ctrl+C` to stop it once confirmed; the actual usage of this command is covered in the run sections below, both for the non-Docker and Docker setups.

   Free-tier ngrok URLs are randomly generated and change every time you restart the tunnel — fine for one-off testing, but if you want a stable URL across sessions, that requires a paid plan for a reserved domain.

   \---

   ### Local setup (no Docker)

   **One-time setup — system dependencies:**

   ```bash
sudo apt update \&\& sudo apt install traceroute python3-venv
```

   **One-time setup — Python environment:**

   ```bash
cd \~/packet-path-visualizer
python3 -m venv backend/venv
source backend/venv/bin/activate
pip install -r backend/requirements.txt
```

   **One-time setup — frontend dependencies:**

   ```bash
cd \~/packet-path-visualizer/frontend
npm install
```

   **One-time setup — traceroute without root:**

   ```bash
sudo setcap cap\_net\_raw+ep $(readlink -f $(which traceroute))
getcap $(readlink -f $(which traceroute))   # confirm it shows cap\_net\_raw=ep
```

   (`readlink -f` resolves through any `update-alternatives` symlinks to the real binary, which is what `setcap` needs to target.)

   **One-time setup — GeoIP database:**
The `GeoLite2-City.mmdb` file is not in the repo (too large, license-gated). Sign up free at maxmind.com, generate a license key, download it, and place it at `backend/GeoLite2-City.mmdb`.

   **One-time setup — environment variables:**

   ```bash
cp .env.example .env
```

   Defaults are fine for local use; edit `.env` only if you need different ports.

   **Running the app:**

   Running the Vite dev server (`npm run dev`, port 5173) directly against the backend is not currently a supported path — the submarine cable overlay's `/api/cables` request gets blocked when the frontend runs on a separate dev-server port from the backend (visible as a failed/blocked request in the browser Network tab). Until that's resolved, always build the frontend and serve it through FastAPI on a single port, even for local-only use:

   **1. Build the frontend into static files:**

   ```bash
cd \~/packet-path-visualizer/frontend
npm run build
```

   This produces `frontend/dist`, which FastAPI is configured to serve directly.

   **2. Start the backend** (this is the only process you need running — there's no separate frontend server):

   ```bash
cd \~/packet-path-visualizer
source backend/venv/bin/activate
uvicorn backend.main:app --reload
```

   **3. Open `http://localhost:8000`** — this serves the full built app, cable overlay included.

   **Remember:** if you change any frontend code, you must re-run `npm run build` (step 1) and refresh — the backend always serves whatever the last build produced, not live source. `uvicorn --reload` only watches backend Python files.

   **Sharing externally with ngrok:** once the app is running per the steps above, just add:

   ```bash
ngrok http 8000
```

   Share the forwarding URL ngrok gives you (e.g. `https://xxxx.ngrok-free.app`) — that's the single link your friend opens.

   \---

   ### Docker setup

   The project ships a `docker-compose.yml` with two profiles:

|Profile|Command|What it runs|
|-|-|-|
|`prod`|`docker compose --profile prod up --build`|Single built image (`app`), serves the compiled frontend as static files through FastAPI on one port. No source mounts, no hot reload.|
|`dev`|`docker compose --profile dev up --build`|`backend-dev` (FastAPI with `--reload`) + `frontend-dev` (Vite dev server with HMR), both with full source mounted for live editing.|

There is intentionally no default/profile-less service — `docker compose up` with no profile flag starts nothing. This avoids the two profiles' services (which both default to port 8000) accidentally colliding.

#### Docker installation inside WSL2 (recommended for Windows users)

If you already have a working Docker install (native Linux, macOS, or you're accepting Docker Desktop's WSL2 integration and its NAT caveat above), skip to [Setup and first run](#setup-and-first-run).

Otherwise, install Docker Engine natively inside your WSL2 distro:

**1. If Docker Desktop's WSL integration is currently enabled for this distro, turn it off first**, to avoid the two installs conflicting: Docker Desktop → Settings → Resources → WSL Integration → disable the toggle for your distro → Apply \& Restart.

**2. Install Docker Engine directly inside WSL:**

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Close and fully reopen your WSL terminal afterward (group membership requires a fresh login session).

**3. Verify it's the native engine, not Docker Desktop's:**

```bash
docker info | grep -i "operating system\\|server version"
which docker
docker compose version
```

`which docker` should point to `/usr/bin/docker`, and `Operating System` should reference your WSL distro directly (e.g. `Ubuntu 24.04...`), not anything Docker-Desktop-related.

#### Setup and first run

**1. GeoIP database** (same requirement as the non-Docker path): place `GeoLite2-City.mmdb` at `backend/GeoLite2-City.mmdb` before starting. Docker Compose mounts it read-only into the container; it won't start correctly without it.

**2. Environment variables:**

```bash
cp .env.example .env
```

**3. Build and run — development (hot reload):**

```bash
docker compose --profile dev up --build
```

Frontend: `http://localhost:5173` (Vite HMR). Backend: `http://localhost:8000`.

**Access the frontend via `http://localhost:5173`, not `http://127.0.0.1:5173`.** Even though they point to the same address, browsers treat them as different origins. The backend's WebSocket handshake only accepts `localhost` as a valid origin, so loading the app via `127.0.0.1` causes every trace to fail with a generic "backend not running" message even though the backend is healthy — it's an origin mismatch, not an actual outage. See [Troubleshooting](#trace-fails-with-backend-not-running-but-the-backend-is-healthy) if you hit this.

**3 (alt). Build and run — production-like (single port, no hot reload):**

```bash
docker compose --profile prod up --build
```

Everything served from `http://localhost:8000`.

**4. Confirm traceroute works inside the container:**

```bash
docker exec -it ppv-backend-dev traceroute -n -m 10 1.1.1.1
```

(swap `ppv-backend-dev` for `ppv-app` if you're testing the `prod` profile). You should see real IPs and RTTs past the first hop. If every hop past #1 times out, see [Troubleshooting](#traceroute-only-shows-1-hop-then-all-timeouts) below.

**5. Tear down:**

```bash
docker compose down
```

#### How raw sockets work inside the container

`traceroute` needs the same `cap\_net\_raw` capability inside Docker as it does outside it. This is handled at two levels simultaneously, both required:

* **Image build time** (`Dockerfile`): `setcap cap\_net\_raw+ep` is applied to the `traceroute` binary, same as the manual local setup.
* **Container runtime** (`docker-compose.yml`): both `app` and `backend-dev` are granted the capability at the container level via:

```yaml
  cap\_add:
    - NET\_RAW
  ```

  Docker containers run with a restricted default capability set, so the file capability alone isn't sufient — the container's bounding set has to include `NET\_RAW` too, or a non-root process can never actually use it even if the binary is flagged for it.

  #### Where logs go when running via Docker

  Log storage differs between the two profiles, matching how each is meant to be used:

  **`prod` (`app` service)** — logs are written to a **named Docker volume** (`ppv-logs`), mounted at `/app/logs` inside the container, so they survive container restarts and recreations. To read them:

  ```bash
docker compose --profile prod logs app          # tail via Docker's own log stream
docker exec -it ppv-app ls /app/logs             # list log files inside the volume
docker exec -it ppv-app cat /app/logs/<filename> # read a specific session's log
```

  Or copy them out to your host filesystem entirely:

  ```bash
docker cp ppv-app:/app/logs ./logs-from-container
```

  The volume persists even if you run `docker compose down` — it's only deleted if you explicitly run `docker compose down -v` or `docker volume rm packet-path-visualizer\_ppv-logs`.

  **`dev` (`backend-dev` service)** — logs are **not** persisted to a volume by design. A host bind mount here would bring host-owned file permissions that don't match the container's non-root `ppv` user, and since `core/logging.py` opens its log file at import time, a permission mismatch would crash the container on startup rather than just failing quietly. So in `dev`, logs live only inside that container's own writable layer and are lost when the container is removed. To inspect them while the container is running:

  ```bash
docker compose logs backend-dev                  # everything printed to stdout/stderr
docker exec -it ppv-backend-dev cat /app/logs/<filename>
```

  If you need dev logs to persist across restarts for some reason, `docker cp` them out before tearing the stack down, the same way as the `prod` example above.

  #### Using P2P file sharing (Send to Friend) when running via Docker

  Containerizing the backend doesn't change how file sharing works, because the actual file transfer never touches the container at all. The `/signal` WebSocket (running inside `app`/`backend-dev`) only relays a handful of small messages — room codes, WebRTC offer/answer, ICE candidates. Once that handshake completes, the two browsers open a direct `RTCDataChannel` to each other and the file bytes flow **browser-to-browser**, bypassing your backend — and therefore Docker — entirely. None of the raw-socket/capability work above has any bearing on this feature; that's specific to the container running `traceroute` itself, which P2P sharing doesn't do.

  The only Docker-relevant question is whether both browsers can reach the signaling endpoint:

  **Same machine (two browser tabs, testing locally)**
Works immediately with either profile — no extra setup needed.

  **Same LAN, different devices**
Use your machine's LAN IP instead of `localhost` on the second device — e.g. `http://192.168.1.x:8000` for `prod`, or `http://192.168.1.x:5173` for `dev`. Since `docker-compose.yml` already publishes `8000:8000` (and `5173:5173` in dev) to the host, this works with zero changes — Docker's port publishing already makes it LAN-reachable, same as running without a container.

  **Different networks entirely (the real "friend anywhere on Earth" case)**
Same as the non-Docker ngrok flow, just pointed at the container's exposed port:

  ```bash
docker compose --profile prod up --build
ngrok http 8000
```

  `prod` is the simplest choice here since it's a single port serving both signaling and the built frontend, so only one ngrok tunnel is needed. `dev` works too — the file transfer mechanism itself doesn't care which profile is running — but needs two separate tunnels (5173 for Vite, 8000 for the backend) and `VITE\_BACKEND\_WS` pointed at the tunneled backend URL instead of `localhost`. Reach for `dev` only if you're actively editing code while testing an external share; otherwise `prod` is less setup for the same result.

  NAT traversal itself (STUN/TURN via `openrelay.metered.ca`) is also unaffected by Docker — the browsers connect to that external relay directly for ICE negotiation, not through your container.

  \---

  ## Troubleshooting

  ### WSL2 builds hang on `apt-get` / `npm ci`

  **Symptom:** a Docker build appears stuck for a very long time (many minutes to over an hour) on a step like `RUN apt-get install traceroute` or `RUN npm ci`, with no error, just silence.

  **Cause:** some WSL2 network configurations resolve common package mirrors to an IPv6 address that WSL2 cannot actually route to, so the connection attempt hangs instead of failing fast and falling back to IPv4.

  **Check:**

  ```bash
curl -6 -v https://deb.debian.org 2>\&1 | head -10
curl -4 -v https://deb.debian.org 2>\&1 | head -10
```

  If the `-6` version hangs or reports "Network is unreachable" while `-4` connects immediately, this is the cause.

  **Fix — disable IPv6 at the WSL/Linux level:**

  ```bash
sudo bash -c 'cat >> /etc/sysctl.conf << EOF
net.ipv6.conf.all.disable\_ipv6 = 1
net.ipv6.conf.default.disable\_ipv6 = 1
net.ipv6.conf.lo.disable\_ipv6 = 1
EOF'
sudo sysctl -p
```

  **Fix — tell Docker's own daemon to avoid IPv6 too:**

  ```bash
sudo bash -c 'cat > /etc/docker/daemon.json << EOF
{
  "dns": \["8.8.8.8", "1.1.1.1"],
  "ipv6": false
}
EOF'
sudo systemctl restart docker
```

  Retry the build after both changes.

  ### `docker.service` hangs on start/restart after switching Docker installs

  **Symptom:** `sudo systemctl restart docker` (or `stop`) never returns, and `systemctl status docker` shows `activating (start)` for minutes, often stuck right after a log line like `"Removing stale sandbox"` or `"Deleting nftables ... rules" error="running nft..."`.

  **Cause:** leftover network namespace/sandbox state from a previous Docker install (e.g. switching away from Docker Desktop's WSL integration) confuses the new daemon during its network cleanup on startup. This lives below normal service restarts, at the WSL2 VM's kernel level.

  **Fix:**

  ```bash
sudo systemctl stop docker
sudo systemctl stop docker.socket
```

  If either of those also hangs, force-kill from a second terminal instead:

  ```bash
sudo pkill -9 dockerd
sudo pkill -9 containerd
```

  Then close **every** WSL terminal window, and from **Windows PowerShell** (not WSL):

  ```powershell
wsl --shutdown
```

  Wait about 10-15 seconds — if Docker Desktop is still running in the background (check the system tray and Task Manager for `vmmem`), fully quit it first, since it can silently relaunch a WSL VM within seconds of shutdown. Then reopen WSL fresh and confirm:

  ```bash
sudo systemctl status docker
```

  It should come back `active (running)` within a few seconds, not minutes.

  ### `traceroute` only shows 1 hop, then all timeouts

  Rule these out in order:

1. **Capability not applied at both levels.** Confirm the file capability survived the image build:

   ```bash
   docker exec -it ppv-backend-dev python3 -c "import os; print(os.getxattr('/usr/bin/traceroute', 'security.capability'))"
   ```

   Should print non-empty bytes. Then confirm the container's bounding set includes it:

   ```bash
   docker exec -it ppv-backend-dev cat /proc/1/status | grep -i cap
   ```

   Check the `CapBnd` hex value has bit `0x2000` set (`CAP\_NET\_RAW`).

2. **Stale container wasn't recreated after a `cap\_add` edit.** `docker compose down` then `up --build --force-recreate` to be sure.
3. **You're on Docker Desktop's WSL2 integration, not a native WSL2 Docker Engine.** This is the most common root cause on Windows. Docker Desktop's Linux engine runs inside its own separate hidden VM, adding a second layer of NAT that reliably drops the ICMP replies `traceroute` depends on for every hop past your own gateway — regardless of capabilities being configured correctly. `network\_mode: host` does **not** fix this on Docker Desktop, because "host" there refers to the Desktop VM's own namespace, not your WSL distro's. The fix is switching to a native Docker Engine installed directly inside WSL2 (see [Docker installation](#docker-installation-inside-wsl2-recommended-for-windows-users) above), which removes that extra NAT hop entirely.

   ### Trace fails with "backend not running" but the backend is healthy

   **Symptom:** the app loads fine, but starting any trace immediately shows an error like "backend not running" or "Error: backend not running" in the sidebar, even though `docker compose ps` / `systemctl status` shows the backend container as up and healthy.

   **Cause:** the app was accessed via `http://127.0.0.1:5173` instead of `http://localhost:5173`. Browsers treat `localhost` and `127.0.0.1` as different origins even though they resolve to the same address, and the backend's WebSocket handshake currently only accepts `localhost` as a valid origin. Loading the page from `127.0.0.1` causes the WebSocket connection for `/trace` to be silently rejected on handshake — the frontend reports this generically as "backend not running," which is misleading since the backend itself is fine.

   **Fix:** always access the app via `http://localhost:5173` (or `http://localhost:8000` for the `prod` profile / built setup), not the `127.0.0.1` form. This is a known limitation for now, not something you need to configure around — a proper fix would widen the backend's accepted WebSocket origins to include both forms, planned as a future cleanup rather than an immediate one.

   ### Port collision on `0.0.0.0:8000`

   **Symptom:** `Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:8000...`

   **Cause:** both `app` (prod) and `backend-dev` (dev) bind host port 8000 by default. If `app` has no `profiles:` key at all, Compose treats it as unconditional and starts it in *every* profile, including `dev`, causing a collision.

   **Fix:** confirm `app` has `profiles: \["prod"]` explicitly set in `docker-compose.yml` (already the case in this repo) and always start with an explicit profile flag — `docker compose --profile dev up` or `docker compose --profile prod up`, never a bare `docker compose up`.

   \---

   ## What it covers

* Real `traceroute` execution with safe subprocess handling (no shell injection), running as a non-root user via Linux capabilities — both natively and inside Docker
* Input validation — backend only accepts known target IDs or validates raw IPs before touching the shell
* Four-state hop classification (OK / PRIVATE / NO GEO / TIMEOUT) with a MaxMind → ip-api.com fallback chain for public IPs
* Live WebSocket streaming — hops appear on the globe as they're discovered, not after the full trace
* A "Clear Trace" control to reset the globe and hop log without starting a new trace
* Submarine cable overlay — the real TeleGeography cable network rendered as a dim background layer, fetched once and cached server-side to avoid CORS and repeat downloads
* WebRTC peer connection with full ICE negotiation and TURN fallback
* Chunked file transfer with backpressure control so large files don't crash the data channel
* Peer IP discovery via `getStats()` (more reliable than parsing ICE candidate strings)
* Trace relay through the data channel so both sender and receiver see the globe animate
* FastAPI serving the built React frontend as static files (single port, no separate frontend server needed in production)
* Non-blocking structured file logging with per-session timestamped log files, component tagging, and JSON metadata on every line
* Telemetry bridge reporting P2P file transfer events (`file\_shared`, `file\_downloaded`) back to the backend log over the existing signaling WebSocket
* Modular backend (`core` / `routers` / `services` / `signaling`) and frontend (`components` / `hooks` / `services` / `utils`) — each concern lives in its own file with a clear interface, instead of one large `main.py` / `App.jsx`
* Dark and light theme support, toggled from the sidebar header, driven entirely by CSS custom properties so the whole UI repaints from one source of truth
* Full Docker Compose setup with separate `prod` (single built image) and `dev` (hot-reload backend + frontend) profiles, raw-socket capability correctly granted at both the image and container level, and a `/healthz` endpoint so the dev stack doesn't depend on a live third-party call to know the backend is ready

  \---

  ## Known limitations

  **All traces run from the backend's machine.** `traceroute` is a system command — browsers can't run it. So whoever is hosting the backend sets the geographic origin of every trace. With ngrok, that's always the host's machine. With a deployed VPS, it would be the server's datacenter. There's no way to trace "from the user's location" without either running the backend on their machine or having a geographically distributed network of backend servers.

  **The last hop into a home network always times out.** Home routers silently drop incoming traceroute probes. This is standard firewall behaviour, not a bug. The route will draw up to the ISP's edge and then stop. You can see this in the hop log as TIMEOUT entries.

  **Geolocation is approximate.** GeoLite2 (and the ip-api.com fallback) are accurate to country/region in most cases, but at the city level they often point to an ISP's headquarters rather than the physical router. Treat it as "approximately here" not "exactly here."

  **The cable overlay is a reference layer, not a routing claim.** It shows the real-world submarine cable network for visual context, but it does not assert that any specific hop in your trace traveled over any specific cable shown — GeoIP accuracy and the density of overlapping cables between major regions make that kind of precise matching unreliable. It's there to give a sense of the physical infrastructure the internet runs on, not to trace an exact path.

  **The arc is a geodesic estimate.** We know the start and end coordinates of each hop pair — the curve between them is the mathematically correct shortest path over the globe (great circle), which roughly matches how undersea cables are laid. It is not the literal cable path.

  **The globe stays dark in light mode.** It's rendering a night-side Earth texture regardless of UI theme, by design — only the sidebar repaints.

  **Docker Desktop's WSL2 integration adds an extra NAT hop that breaks traceroute.** If you run this project's containers through Docker Desktop's WSL integration rather than a native Docker Engine inside WSL2, expect every hop past your own gateway to time out, regardless of capability configuration — see [Troubleshooting](#traceroute-only-shows-1-hop-then-all-timeouts) above. This is a platform limitation of Docker Desktop's networking model on Windows, not something fixable purely from this project's compose file.

  \---

  ## What's not built yet

* **Simplify setup and development workflow — While the application is fully containerized, the current development setup still requires several manual steps and environment-specific considerations (WSL2, Docker capabilities, profiles, etc.). Reducing this complexity is the next priority before expanding functionality.**
* **Backend WebSocket origin check is too strict** — currently only accepts `localhost` as a valid origin, rejecting the functionally-identical `127.0.0.1` and causing a misleading "backend not running" error. Should accept both.
* **Deployment** — The app runs on localhost + ngrok (or Docker on localhost) for now. Deploying to a VPS (DigitalOcean, Linode, etc.) would make it publicly accessible without ngrok and would allow traces to originate from the server instead of the local development machine.
* **Self-hosted TURN server** — Currently using a free public TURN relay (openrelay.metered.ca). For production, a dedicated coturn instance on the same VPS would be more reliable and private.
* **Bidirectional file transfer** — Currently only the host can send a file to the guest. Making it bidirectional (either side can send) is a small data channel protocol change.
* **Mobile layout** — The sidebar + globe split doesn't adapt well to small screens.
* **Theme persistence** — The dark/light choice currently resets to dark on every page reload; saving it (e.g. to `localStorage`) would make it stick across sessions.

