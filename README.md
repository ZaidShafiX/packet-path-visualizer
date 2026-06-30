# Packet Path Visualizer

**Send a file to a friend anywhere on Earth and watch the network path it travels, drawn live on a 3D globe — submarine cables and all.**

---

## What it does

When you send data across the internet, it doesn't travel in a straight line. It jumps through a chain of routers — each one passing it along to the next. This project makes that journey visible.

There are two modes:

**Route Trace (V1)** — Pick a destination server (Google DNS, Cloudflare, AWS Tokyo, etc.) and hit Start. The backend runs a real `traceroute` command, classifies and geolocates each router it discovers, and streams the results to the frontend one hop at a time. The globe draws an animated arc between each hop as they arrive — you watch the path build itself in real time, layered over a backdrop of the world's real submarine cable routes.

**Send to Friend (V2)** — You and a friend both open the app. You create a room and share the 6-character code with them. They join. Your browsers negotiate a direct WebRTC peer-to-peer connection. You pick a file — it transfers directly from your browser to theirs, no server in the middle. The moment the connection is established, the backend runs a traceroute to your friend's public IP and draws the route on the globe. Both of you see the same path animate simultaneously, in sync with the file transfer happening in the background.

---

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

**The backend** runs in Python with FastAPI, without requiring root privileges — `traceroute` is granted the `cap_net_raw` Linux capability directly (`setcap cap_net_raw+ep`) so it can open raw sockets as a normal user. It's organized into focused modules rather than one large file:

- `core/` — configuration constants and the non-blocking logging setup
- `routers/` — the three FastAPI route handlers (`trace.py`, `signal.py`, `cables.py`), kept thin and delegating to services
- `services/` — the actual traceroute runner, ASN/BGP lookup, reverse DNS, and geolocation logic
- `signaling/` — WebRTC room lifecycle management and the telemetry bridge

It exposes three WebSocket endpoints — `/trace` for curated V1 destinations, `/trace-ip` for tracing to a peer's discovered IP, and `/signal` as the WebRTC signaling relay — plus a small REST endpoint, `/api/cables`, that proxies and caches the submarine cable GeoJSON server-side (avoiding CORS issues with fetching it directly from the browser). It also serves the built frontend as static files so everything runs through one port.

**The frontend** is React, similarly split into components rather than a single `App.jsx`:

- `components/Globe/` — the globe.gl WebGL instance, submarine cable overlay, and the cable-info/transfer-progress UI that sits on top of it
- `components/Sidebar/` — `Sidebar.jsx` (shell + theme toggle) and one view component per screen: `HomeView`, `TraceView`, `TransferView`, `SummaryView`
- `components/shared/` — small reusable pieces (`ProgressBar`, `ThemeToggle`)
- `hooks/` — `useFileTransfer` (WebRTC: ICE negotiation, data channel, chunked sending with backpressure, peer IP discovery via `getStats()`) and `useTraceroute` (trace lifecycle, hop state, globe point/arc updates)
- `services/` — `signaling.js` (WebSocket signaling client) and `telemetry.js` (file-transfer event reporting)
- `utils/summary.js` — trace summary statistics (hop counts, RTT min/max/avg, ASN/country counts, exit point inference)

`App.jsx` wires these together and owns top-level navigation state (`view`) and the active theme.

**Light and dark themes.** The whole sidebar (not the globe — that stays dark in both modes, since it's rendering a night-side Earth texture) switches between a warm charcoal dark mode, and a clean white light mode. The toggle lives top-right in the sidebar header; the choice is applied via a `data-theme` attribute on `<html>`, and every color in `App.css` is a CSS custom property so the two palettes stay in one place rather than scattered `dark:` overrides.

**Geolocation** uses a local MaxMind GeoLite2 binary database as the primary source, with `ip-api.com` as a live fallback for IPs MaxMind can't resolve (e.g. backbone/anycast routers). Each hop is classified into one of four states before being sent to the frontend:
- **OK** — a public IP, successfully geolocated
- **PRIVATE** — an RFC 1918 / CGNAT / reserved address (internal ISP infrastructure that responded, but isn't placeable on a map)
- **NO GEO** — a public IP that responded but couldn't be geolocated by either MaxMind or the fallback
- **TIMEOUT** — no response at all from that hop

**The logging system** uses Python's built-in `logging` module with a non-blocking architecture — a `QueueHandler` pushes log records onto an in-memory queue instantly, and a background `QueueListener` thread handles the actual disk writes, so a slow disk can never stall a live traceroute or WebRTC handshake. Every line follows the format:

```
[TIMESTAMP] [LEVEL] [COMPONENT] - Message | Metadata: {JSON}
```

A new timestamped log file is created per server session under `logs/`. The `logs/` directory is tracked in git (via `.gitkeep`) but all `*.log` files are gitignored.

**The telemetry bridge** solves a specific observability gap: since file transfers are pure P2P (the backend never sees the actual bytes), the frontend sends a small JSON message over the already-open signaling WebSocket when a file is sent or received. The backend intercepts these, logs them at `[INFO]`, and does not relay them to the other peer. This means the log records the full session — room lifecycle, WebRTC handshake, and file transfer events — even though the backend was never in the data path.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Backend | Python + FastAPI | Async WebSocket support, runs system commands, modular routers/services |
| Geolocation | MaxMind GeoLite2 + ip-api.com fallback | Local binary DB for instant lookups, live API for what MaxMind misses |
| Frontend | React + Vite | Component model, fast dev server |
| 3D Globe | globe.gl | WebGL rendering, geodesic arcs, atmosphere, path overlays |
| Submarine cables | submarinecablemap.com (TeleGeography) GeoJSON | Real-world cable routes as a reference layer, proxied through the backend |
| P2P Transfer | WebRTC RTCDataChannel | Direct browser-to-browser, no server relay for data |
| NAT Traversal | STUN + TURN (openrelay) | Handles strict firewalls and symmetric NAT |
| Theming | CSS custom properties + `data-theme` attribute | Single source of truth for dark/light palettes, no per-component overrides |
| Logging | Python built-in `logging` + QueueListener | Non-blocking file logging, one timestamped file per session |
| Dev tunneling | ngrok | Exposes localhost backend for remote testing |

---

## Prerequisites

**The backend requires Linux or WSL.** It will not run on Windows natively. This is a hard requirement — the backend shells out to the system `traceroute` command, which relies on raw socket access that is only available on Linux. If you're on Windows, use WSL (Windows Subsystem for Linux). macOS works natively.

Everything else (frontend, browser) works on any platform.

---

## Running locally

You need two terminals.

**Terminal 1 — Backend:**
```bash
cd ~/packet-path-visualizer
source backend/venv/bin/activate
uvicorn backend.main:app --reload
```

**Terminal 2 — Frontend (dev):**
```bash
cd ~/packet-path-visualizer/frontend
npm run dev
```

Open `http://localhost:5173`.

**For remote access (ngrok):**
```bash
ngrok http 8000
```
Then build the frontend so FastAPI serves it:
```bash
cd frontend && npm run build
```
Everything runs through the single ngrok URL. Remember to rebuild (`npm run build`) after every frontend change — the ngrok URL serves the compiled `frontend/dist` bundle, not live source.

**Note:** The `GeoLite2-City.mmdb` file is not in the repo (too large, license-gated). Sign up free at maxmind.com, generate a license key, download it, and place it at `backend/GeoLite2-City.mmdb`.

**One-time setup — traceroute without root:**
```bash
sudo apt update && sudo apt install traceroute
sudo setcap cap_net_raw+ep $(readlink -f $(which traceroute))
getcap $(readlink -f $(which traceroute))   # confirm it shows cap_net_raw=ep
```
(`readlink -f` resolves through any `update-alternatives` symlinks to the real binary, which is what `setcap` needs to target.)

---

## What it covers

- Real `traceroute` execution with safe subprocess handling (no shell injection), running as a non-root user via Linux capabilities
- Input validation — backend only accepts known target IDs or validates raw IPs before touching the shell
- Four-state hop classification (OK / PRIVATE / NO GEO / TIMEOUT) with a MaxMind → ip-api.com fallback chain for public IPs
- Live WebSocket streaming — hops appear on the globe as they're discovered, not after the full trace
- A "Clear Trace" control to reset the globe and hop log without starting a new trace
- Submarine cable overlay — the real TeleGeography cable network rendered as a dim background layer, fetched once and cached server-side to avoid CORS and repeat downloads
- WebRTC peer connection with full ICE negotiation and TURN fallback
- Chunked file transfer with backpressure control so large files don't crash the data channel
- Peer IP discovery via `getStats()` (more reliable than parsing ICE candidate strings)
- Trace relay through the data channel so both sender and receiver see the globe animate
- FastAPI serving the built React frontend as static files (single port, no separate frontend server needed in production)
- Non-blocking structured file logging with per-session timestamped log files, component tagging, and JSON metadata on every line
- Telemetry bridge reporting P2P file transfer events (`file_shared`, `file_downloaded`) back to the backend log over the existing signaling WebSocket
- Modular backend (`core` / `routers` / `services` / `signaling`) and frontend (`components` / `hooks` / `services` / `utils`) — each concern lives in its own file with a clear interface, instead of one large `main.py` / `App.jsx`
- Dark and light theme support, toggled from the sidebar header, driven entirely by CSS custom properties so the whole UI repaints from one source of truth

---

## Known limitations

**The backend only runs on Linux or WSL.** The `traceroute` command and `cap_net_raw` Linux capability are not available on Windows natively. See Prerequisites above.

**All traces run from the backend's machine.** `traceroute` is a system command — browsers can't run it. So whoever is hosting the backend sets the geographic origin of every trace. With ngrok, that's always the host's machine. With a deployed VPS, it would be the server's datacenter. There's no way to trace "from the user's location" without either running the backend on their machine or having a geographically distributed network of backend servers.

**The last hop into a home network always times out.** Home routers silently drop incoming traceroute probes. This is standard firewall behaviour, not a bug. The route will draw up to the ISP's edge and then stop. You can see this in the hop log as TIMEOUT entries.

**Geolocation is approximate.** GeoLite2 (and the ip-api.com fallback) are accurate to country/region in most cases, but at the city level they often point to an ISP's headquarters rather than the physical router. Treat it as "approximately here" not "exactly here."

**The cable overlay is a reference layer, not a routing claim.** It shows the real-world submarine cable network for visual context, but it does not assert that any specific hop in your trace traveled over any specific cable shown — GeoIP accuracy and the density of overlapping cables between major regions make that kind of precise matching unreliable. It's there to give a sense of the physical infrastructure the internet runs on, not to trace an exact path.

**The arc is a geodesic estimate.** We know the start and end coordinates of each hop pair — the curve between them is the mathematically correct shortest path over the globe (great circle), which roughly matches how undersea cables are laid. It is not the literal cable path.

**The globe stays dark in light mode.** It's rendering a night-side Earth texture regardless of UI theme, by design — only the sidebar repaints.

---

## What's not built yet

- **Dockerization** — The app is not yet containerized. The goal is a `docker-compose` setup with separate backend and frontend containers, making it portable and deployable without manual environment setup. The Linux-only `traceroute` + `cap_net_raw` requirement needs special handling here — the backend container will need the capability granted at the Docker level (`--cap-add NET_RAW`).
- **Deployment** — The app runs on localhost + ngrok for now. Deploying to a VPS (DigitalOcean, Linode, etc.) would make it publicly accessible without ngrok and would also fix the "traces always start from my machine" limitation.
- **Self-hosted TURN server** — Currently using a free public TURN relay (openrelay.metered.ca). For production, a dedicated coturn instance on the same VPS would be more reliable and private.
- **Bidirectional file transfer** — Currently only the host can send a file to the guest. Making it bidirectional (either side can send) is a small data channel protocol change.
- **Mobile layout** — The sidebar + globe split doesn't adapt well to small screens.
- **Theme persistence** — The dark/light choice currently resets to dark on every page reload; saving it (e.g. to `localStorage`) would make it stick across sessions.