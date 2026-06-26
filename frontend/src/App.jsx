import { useEffect, useRef, useState, useCallback } from "react";
import Globe from "globe.gl";
import { useFileTransfer } from "./hooks/useFileTransfer";
import "./App.css";

const BACKEND_WS = window.location.hostname === "localhost"
  ? "ws://localhost:8000"
  : `wss://${window.location.host}`;

const CABLE_GEO_URL = "/api/cables";

const TARGETS = [
  { id: "google",     label: "🌐 Google DNS (8.8.8.8)" },
  { id: "cloudflare", label: "⚡ Cloudflare DNS (1.1.1.1)" },
  { id: "london",     label: "🇬🇧 London — BBC" },
  { id: "tokyo",      label: "🇯🇵 Tokyo — AWS" },
  { id: "new-york",   label: "🇺🇸 New York — Fastly" },
];

const DEFAULT_STATUS = "Select a destination and start a trace";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${["B","KB","MB","GB"][i]}`;
}

/**
 * Parse the TeleGeography GeoJSON into the flat array pathsData expects.
 *
 * Each GeoJSON Feature has geometry.type === "MultiLineString", meaning
 * geometry.coordinates is an array of separate line segments (a cable can
 * split around islands, branch to multiple landing points, etc).
 *
 * We flatten each segment into its own path object so globe.gl draws each
 * continuous segment as one unbroken line, rather than connecting
 * geographically separate segments with a straight line across the globe.
 *
 * GeoJSON coordinates are [lng, lat] — globe.gl wants lat/lng separately,
 * so we wire pathPointLat(p => p[1]) and pathPointLng(p => p[0]).
 */
function parseCableGeoJSON(geojson) {
  const paths = [];
  for (const feature of geojson.features) {
    const { color, name } = feature.properties;
    const { type, coordinates } = feature.geometry;

    if (type === "MultiLineString") {
      for (const segment of coordinates) {
        if (segment.length >= 2) {
          paths.push({ coords: segment, color, name });
        }
      }
    } else if (type === "LineString") {
      if (coordinates.length >= 2) {
        paths.push({ coords: coordinates, color, name });
      }
    }
  }
  return paths;
}

export default function App() {
  const globeDivRef    = useRef(null);
  const globeRef       = useRef(null);
  const pointsRef      = useRef([]);
  const arcsRef        = useRef([]);
  const tracingRef     = useRef(false);
  const relayHopRef    = useRef(null);
  const roleRef        = useRef(null);
  const relayedHopsRef = useRef([]);

  const [hops, setHops]               = useState([]);
  const [traceStatus, setTraceStatus] = useState(DEFAULT_STATUS);
  const [tracing, setTracing]         = useState(false);
  const [target, setTarget]           = useState("google");
  const [tab, setTab]                 = useState("trace");
  const [joinCode, setJoinCode]       = useState("");
  const [cablesLoaded, setCablesLoaded] = useState(false);
  const fileInputRef = useRef(null);

  // ── Globe init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (globeRef.current) return;
    const g = Globe()(globeDivRef.current);
    g.globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
     .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
     .atmosphereColor("#1a8cff").atmosphereAltitude(0.15)
     // Trace hop points
     .pointsData([]).pointLat("lat").pointLng("lng")
     .pointColor(() => "#3b82f6").pointAltitude(0.01).pointRadius(0.4)
     .pointLabel(d => `<div style="background:#111827;color:#e2e8f0;padding:8px 12px;border-radius:8px;font-family:-apple-system,sans-serif;font-size:12px;border:1px solid #1e293b;line-height:1.5"><b style="color:#60a5fa">Hop ${d.hop}</b><br/>${d.city}<br/><span style="color:#64748b;font-family:monospace">${d.ip||""}</span></div>`)
     // Trace hop arcs
     .arcsData([]).arcStartLat("startLat").arcStartLng("startLng").arcEndLat("endLat").arcEndLng("endLng")
     .arcColor(() => "#3b82f6").arcAltitude(0.3).arcStroke(0.5)
     .arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(1500)
     // Submarine cable paths — empty until fetch resolves
     .pathsData([])
     .pathPoints("coords")
     .pathPointLat(p => p[1])
     .pathPointLng(p => p[0])
     .pathPointAlt(0)
     .pathColor(path => [
       `${path.color}28`,
       `${path.color}70`,
       `${path.color}28`,
     ])
     .pathStroke(0.8)
     .pathDashLength(0.02)
     .pathDashGap(0.006)
     .pathDashAnimateTime(20000)
     .pathLabel(path => `
       <div style="background:#111827;color:#e2e8f0;padding:6px 10px;border-radius:6px;
                   font-family:-apple-system,sans-serif;font-size:11px;border:1px solid #1e293b">
         🌊 ${path.name}
       </div>
     `);

    g.width(globeDivRef.current.clientWidth);
    g.height(globeDivRef.current.clientHeight);
    g.pointOfView({ lat: 30, lng: 50, altitude: 2 }, 0);
    globeRef.current = g;

    const onResize = () => {
      g.width(globeDivRef.current.clientWidth);
      g.height(globeDivRef.current.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Submarine cable fetch ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadCables() {
      try {
        const res = await fetch(CABLE_GEO_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const geojson = await res.json();
        if (cancelled) return;

        const paths = parseCableGeoJSON(geojson);

        const applyWhenReady = () => {
          if (globeRef.current) {
            globeRef.current.pathsData(paths);
            setCablesLoaded(true);
          } else {
            setTimeout(applyWhenReady, 100);
          }
        };
        applyWhenReady();
      } catch (err) {
        console.warn("Submarine cable fetch failed:", err.message);
      }
    }

    loadCables();
    return () => { cancelled = true; };
  }, []);

  // ── Clear Trace ────────────────────────────────────────────────────────────
  const clearTrace = useCallback(() => {
    setHops([]);
    pointsRef.current = [];
    arcsRef.current   = [];
    globeRef.current?.pointsData([]);
    globeRef.current?.arcsData([]);
    setTraceStatus(DEFAULT_STATUS);
  }, []);

  // ── Shared traceroute runner ───────────────────────────────────────────────
  const runTrace = useCallback((wsUrl, label) => {
    tracingRef.current = true;
    setTracing(true);
    setHops([]);
    setTraceStatus(label || "Tracing...");
    pointsRef.current = [];
    arcsRef.current   = [];
    globeRef.current?.pointsData([]);
    globeRef.current?.arcsData([]);

    relayHopRef.current?.({ reset: true });

    const ws = new WebSocket(wsUrl);
    const collected = [];

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.error) {
        setTraceStatus(`Error: ${data.error}`);
        setTracing(false); tracingRef.current = false;
        return;
      }

      if (data.done) {
        const located = collected.filter(h => !h.timeout && !h.is_private).length;
        setTraceStatus(`Trace complete — ${collected.length} hops, ${located} located`);
        setTracing(false); tracingRef.current = false;
        relayHopRef.current?.({ done: true, total: collected.length, located });
        ws.close();
        return;
      }

      collected.push(data);
      setHops([...collected]);
      relayHopRef.current?.(data);

      // Only plot geolocated public hops on the globe
      if (!data.timeout && !data.is_private && data.lat && data.lng) {
        pointsRef.current = [...pointsRef.current, data];
        globeRef.current?.pointsData(pointsRef.current);

        const prev = collected.slice(0, -1).reverse().find(h => !h.timeout && !h.is_private && h.lat);
        if (prev) {
          arcsRef.current = [...arcsRef.current, {
            startLat: prev.lat, startLng: prev.lng,
            endLat: data.lat,   endLng: data.lng,
          }];
          globeRef.current?.arcsData(arcsRef.current);
        }

        globeRef.current?.pointOfView({ lat: data.lat, lng: data.lng, altitude: 2 }, 1000);
      }
    };

    ws.onerror = () => {
      setTraceStatus("Error: backend not running");
      setTracing(false); tracingRef.current = false;
    };
  }, []);

  const startTrace = () => runTrace(`${BACKEND_WS}/trace?target=${target}`);

  const startTraceToIP = useCallback((ip) => {
    if (roleRef.current === "guest") {
      setTraceStatus("Receiving route trace from host...");
      setTab("trace");
      return;
    }
    runTrace(`${BACKEND_WS}/trace-ip?ip=${ip}`, `Tracing path to peer (${ip})...`);
    setTab("trace");
  }, [runTrace]);

  const handleRelayedHop = useCallback((data) => {
    if (data.reset) {
      relayedHopsRef.current = [];
      pointsRef.current = [];
      arcsRef.current   = [];
      globeRef.current?.pointsData([]);
      globeRef.current?.arcsData([]);
      setHops([]);
      setTraceStatus("Receiving route trace from host...");
      setTab("trace");
      return;
    }

    if (data.done) {
      setTraceStatus(`Trace complete — ${data.total} hops, ${data.located} located`);
      return;
    }

    relayedHopsRef.current = [...relayedHopsRef.current, data];
    setHops([...relayedHopsRef.current]);

    if (!data.timeout && !data.is_private && data.lat && data.lng) {
      pointsRef.current = [...pointsRef.current, data];
      globeRef.current?.pointsData(pointsRef.current);

      const prev = relayedHopsRef.current.slice(0, -1).reverse().find(h => !h.timeout && !h.is_private && h.lat);
      if (prev) {
        arcsRef.current = [...arcsRef.current, {
          startLat: prev.lat, startLng: prev.lng,
          endLat: data.lat,   endLng: data.lng,
        }];
        globeRef.current?.arcsData(arcsRef.current);
      }

      globeRef.current?.pointOfView({ lat: data.lat, lng: data.lng, altitude: 2 }, 1000);
    }
  }, []);

  const transfer = useFileTransfer({
    onPeerIpDiscovered: startTraceToIP,
    onTraceHop: handleRelayedHop,
  });

  relayHopRef.current = transfer.relayTraceHop;
  roleRef.current     = transfer.role;

  const handlePickFile = (e) => {
    const file = e.target.files[0];
    if (file) transfer.sendFile(file);
    e.target.value = "";
  };

  // ── Hop card class helper ──────────────────────────────────────────────────
  const hopCardClass = (h) => {
    if (h.timeout)     return "hop-card hop-warn";
    if (h.is_private)  return "hop-card hop-internal";
    if (h.no_location) return "hop-card hop-nogeo";
    return "hop-card hop-ok";
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      <div className="globe-section">
        <div ref={globeDivRef} className="globe-canvas" />

        {!cablesLoaded && (
          <div className="cable-loading">
            <span className="cable-loading-dot" />
            Loading submarine cables…
          </div>
        )}

        {(transfer.sendProgress !== null || transfer.receiveProgress !== null) && (
          <div className="transfer-panel">
            {transfer.sendProgress !== null && (
              <div className="progress-row">
                <span className="progress-label">Sending</span>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${transfer.sendProgress}%` }} />
                </div>
                <span className="progress-pct">{transfer.sendProgress}%</span>
              </div>
            )}
            {transfer.receiveProgress !== null && (
              <div className="progress-row">
                <span className="progress-label">Receiving</span>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${transfer.receiveProgress}%` }} />
                </div>
                <span className="progress-pct">{transfer.receiveProgress}%</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sidebar">
        <div className="sidebar-header">
          <div className="app-title">
            <div className="app-title-icon">🌐</div>
            <span className="app-title-text">Packet Path Visualizer</span>
            <span className="app-title-badge">LIVE</span>
          </div>
          <div className="tab-bar">
            <button className={`tab ${tab === "trace"    ? "active" : ""}`} onClick={() => setTab("trace")}>Route Trace</button>
            <button className={`tab ${tab === "transfer" ? "active" : ""}`} onClick={() => setTab("transfer")}>Send to Friend</button>
          </div>
        </div>

        <div className="control-panel">
          {tab === "trace" && (
            <>
              <div className="control-panel-label">Destination</div>
              <div className="control-row">
                <select className="select-target" value={target} onChange={e => setTarget(e.target.value)} disabled={tracing}>
                  {TARGETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <button className="btn-primary" onClick={startTrace} disabled={tracing}>
                  {tracing ? "Tracing…" : "▶ Start"}
                </button>
                <button className="btn-clear" onClick={clearTrace} disabled={tracing}>
                  ✕ Clear
                </button>
              </div>
              <div className="status-line">{traceStatus}</div>
            </>
          )}

          {tab === "transfer" && (
            <>
              {transfer.role === null && (
                <>
                  <div className="control-panel-label">Start or Join</div>
                  <div className="control-row">
                    <button className="btn-primary" onClick={transfer.hostTransfer}>📡 Host Transfer</button>
                    <input className="room-input" placeholder="ROOM CODE" maxLength={6}
                      value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
                    <button className="btn-secondary" disabled={joinCode.length !== 6}
                      onClick={() => transfer.joinTransfer(joinCode)}>Join</button>
                  </div>
                </>
              )}

              {transfer.role === "host" && transfer.connState === "waiting" && transfer.roomCode && (
                <>
                  <div className="control-panel-label">Your Room Code</div>
                  <div className="room-code-display">
                    <span className="room-code-value">{transfer.roomCode}</span>
                  </div>
                </>
              )}

              {transfer.connState === "connected" && (
                <>
                  <div className="control-panel-label">Connected</div>
                  <div className="control-row">
                    {transfer.role === "host" && (
                      <>
                        <input ref={fileInputRef} type="file" hidden onChange={handlePickFile} />
                        <button className="btn-primary" onClick={() => fileInputRef.current.click()}>📤 Choose File</button>
                      </>
                    )}
                    {transfer.peerIp && (
                      <span className="peer-ip-badge">
                        <span className="peer-ip-dot" />
                        {transfer.peerIp}
                      </span>
                    )}
                    <button className="btn-ghost" onClick={transfer.reset}>✕ Reset</button>
                  </div>
                </>
              )}

              {transfer.incomingFile && (
                <div style={{ marginTop: "10px" }}>
                  <a className="btn-download" href={transfer.incomingFile.url} download={transfer.incomingFile.name}>
                    ⬇ {transfer.incomingFile.name} ({formatBytes(transfer.incomingFile.size)})
                  </a>
                </div>
              )}

              {transfer.role && transfer.connState !== "connected" && (
                <div style={{ marginTop: "10px" }}>
                  <button className="btn-ghost" onClick={transfer.reset}>✕ Reset</button>
                </div>
              )}

              <div className="status-line">{transfer.statusText}</div>
            </>
          )}
        </div>

        <div className="hop-log">
          {hops.length === 0 ? (
            <div className="hop-log-empty">
              <span className="hop-log-empty-icon">📡</span>
              <span>No hops yet. Start a trace to see the network path.</span>
            </div>
          ) : (
            <>
              <div className="hop-log-header">
                <span className="hop-log-title">Network Path</span>
                <div className="hop-log-rule" />
                <span className="hop-count-badge">{hops.length} hops</span>
              </div>
              {hops.map(h => (
                <div key={h.hop} className={hopCardClass(h)}>
                  <span className="hop-number">{h.hop}</span>
                  <div className="hop-info">
                    {h.timeout ? (
                      <>
                        <div className="hop-city" style={{ color: "#94a3b8" }}>Unknown</div>
                        <div className="hop-ip">No response</div>
                      </>
                    ) : (
                      <>
                        <div className="hop-city">{h.city}</div>
                        {h.ip && <div className="hop-ip">{h.ip}</div>}
                      </>
                    )}
                  </div>
                  {h.timeout ? (
                    <span className="hop-status-warn">TIMEOUT</span>
                  ) : h.is_private ? (
                    <span className="hop-status-internal">PRIVATE</span>
                  ) : h.no_location ? (
                    <span className="hop-status-nogeo">NO GEO</span>
                  ) : (
                    <span className="hop-status-ok">OK</span>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}