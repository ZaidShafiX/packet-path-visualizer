# Packet Path Visualizer

**Send a file to a friend anywhere on Earth and watch the network path it travels, drawn live on a 3D globe.**

---

## What it does

When you send data across the internet, it doesn't travel in a straight line. It jumps through a chain of routers — each one passing it along to the next. This project makes that journey visible.

There are two modes:

**Route Trace (V1)** — Pick a destination server (Google DNS, Cloudflare, AWS Tokyo, etc.) and hit Start. The backend runs a real `traceroute` command, looks up the geographic location of each router it discovers, and streams the results to the frontend one hop at a time. The globe draws an animated arc between each hop as they arrive — you watch the path build itself in real time.

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
     │                                  │ looks up each IP in GeoIP  │
     │◄──── hop data streamed back ─────│                            │
     │                                  │                            │
     │──── relay hops via DataChannel ───────────────────────────────►│
     │     (friend's globe draws same path)                           │
```

**The backend** runs in Python with FastAPI. It handles three WebSocket endpoints: `/trace` for curated V1 destinations, `/trace-ip` for tracing to a peer's discovered IP, and `/signal` as the WebRTC signaling relay. It also serves the built frontend as static files so everything runs through one port.

**The frontend** is React. The globe is rendered using globe.gl (WebGL via Three.js). All the WebRTC logic — ICE negotiation, data channel, file chunking with backpressure, peer IP discovery via `getStats()` — lives in a custom hook (`useFileTransfer`).

**Geolocation** uses a local MaxMind GeoLite2 binary database. No external API calls, no rate limits — each IP is looked up in microseconds from a local `.mmdb` file.

---

## Tech stack

| Layer | Tool | Why |
|---|---|---|
| Backend | Python + FastAPI | Async WebSocket support, runs system commands |
| Geolocation | MaxMind GeoLite2 | Local binary DB, instant lookups, no rate limits |
| Frontend | React + Vite | Component model, fast dev server |
| 3D Globe | globe.gl | WebGL rendering, geodesic arcs, atmosphere |
| P2P Transfer | WebRTC RTCDataChannel | Direct browser-to-browser, no server relay for data |
| NAT Traversal | STUN + TURN (openrelay) | Handles strict firewalls and symmetric NAT |
| Dev tunneling | ngrok | Exposes localhost backend for remote testing |

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
Everything runs through the single ngrok URL.

**Note:** The `GeoLite2-City.mmdb` file is not in the repo (too large, license-gated). Sign up free at maxmind.com, generate a license key, download it, and place it at `backend/GeoLite2-City.mmdb`.

---

## What it covers

- Real `traceroute` execution with safe subprocess handling (no shell injection)
- Input validation — backend only accepts known target IDs or validates raw IPs before touching the shell
- Live WebSocket streaming — hops appear on the globe as they're discovered, not after the full trace
- WebRTC peer connection with full ICE negotiation and TURN fallback
- Chunked file transfer with backpressure control so large files don't crash the data channel
- Peer IP discovery via `getStats()` (more reliable than parsing ICE candidate strings)
- Trace relay through the data channel so both sender and receiver see the globe animate
- FastAPI serving the built React frontend as static files (single port, no separate frontend server needed in production)

---

## Known limitations

**All traces run from the backend's machine.** `traceroute` is a system command — browsers can't run it. So whoever is hosting the backend sets the geographic origin of every trace. With ngrok, that's always the host's machine. With a deployed VPS, it would be the server's datacenter. There's no way to trace "from the user's location" without either running the backend on their machine or having a geographically distributed network of backend servers.

**The last hop into a home network always times out.** Home routers silently drop incoming traceroute probes. This is standard firewall behaviour, not a bug. The route will draw up to the ISP's edge and then stop. You can see this in the hop log as TIMEOUT entries.

**Geolocation is approximate.** GeoLite2 is accurate to country/region in most cases, but at the city level it often points to an ISP's headquarters rather than the physical router. Treat it as "approximately here" not "exactly here."

**The arc is a geodesic estimate.** We know the start and end coordinates of each hop pair — the curve between them is the mathematically correct shortest path over the globe (great circle), which roughly matches how undersea cables are laid. It is not the literal cable path.

---

## What's not built yet

- **Deployment** — The app runs on localhost + ngrok for now. Deploying to a VPS (DigitalOcean, Linode, etc.) would make it publicly accessible without ngrok and would also fix the "traces always start from my machine" limitation.
- **Self-hosted TURN server** — Currently using a free public TURN relay (openrelay.metered.ca). For production, a dedicated coturn instance on the same VPS would be more reliable and private.
- **Submarine cable overlay** — Cross-referencing hop paths against the real submarine cable database (submarinecablemap.com) to show which physical cables the data likely used.
- **Bidirectional file transfer** — Currently only the host can send a file to the guest. Making it bidirectional (either side can send) is a small data channel protocol change.
- **Mobile layout** — The sidebar + globe split doesn't adapt well to small screens.
