import { useEffect, useRef, useState, useCallback } from "react";
import Globe from "globe.gl";
import { useFileTransfer } from "./hooks/useFileTransfer";
import "./App.css";

const TARGETS = [
  { id: "google",     label: "🌐 Google DNS (8.8.8.8)" },
  { id: "cloudflare", label: "⚡ Cloudflare DNS (1.1.1.1)" },
  { id: "london",     label: "🇬🇧 London — BBC" },
  { id: "tokyo",      label: "🇯🇵 Tokyo — AWS" },
  { id: "new-york",   label: "🇺🇸 New York — Fastly" },
];

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${["B","KB","MB","GB"][i]}`;
}

export default function App() {
  const globeDivRef = useRef(null);
  const globeRef    = useRef(null);
  const pointsRef   = useRef([]);
  const arcsRef     = useRef([]);
  const tracingRef  = useRef(false); // ref so V2 callback always sees current value

  const [hops, setHops]       = useState([]);
  const [traceStatus, setTraceStatus] = useState("Pick a destination and hit Start Trace");
  const [tracing, setTracing] = useState(false);
  const [target, setTarget]   = useState("google");
  const [tab, setTab]         = useState("trace");
  const [joinCode, setJoinCode] = useState("");
  const fileInputRef = useRef(null);

  // ── Globe init ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (globeRef.current) return;
    const g = Globe()(globeDivRef.current);
    g.globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
     .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
     .atmosphereColor("#1a8cff").atmosphereAltitude(0.15)
     .pointsData([]).pointLat("lat").pointLng("lng")
     .pointColor(() => "#00ff88").pointAltitude(0.01).pointRadius(0.4)
     .pointLabel(d => `<div style="background:#0d1117;color:#00ff88;padding:6px 10px;border-radius:6px;font-family:monospace;font-size:12px;border:1px solid #21262d"><b>Hop ${d.hop}</b><br/>${d.city}<br/><span style="color:#8b949e">${d.ip||""}</span></div>`)
     .arcsData([]).arcStartLat("startLat").arcStartLng("startLng").arcEndLat("endLat").arcEndLng("endLng")
     .arcColor(() => "#00ff88").arcAltitude(0.3).arcStroke(0.5)
     .arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(1500);
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

  // ── Shared traceroute runner — V1 uses curated targets, V2 uses peer IP ──
  const runTrace = useCallback((wsUrl, label) => {
    // Force-stop any existing trace so V2 can always trigger cleanly
    tracingRef.current = true;
    setTracing(true);
    setHops([]);
    setTraceStatus(label || "Tracing...");
    pointsRef.current = [];
    arcsRef.current   = [];
    globeRef.current?.pointsData([]);
    globeRef.current?.arcsData([]);

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
        const located = collected.filter(h => !h.timeout).length;
        setTraceStatus(`Trace complete — ${collected.length} hops, ${located} located`);
        setTracing(false); tracingRef.current = false;
        ws.close();
        return;
      }

      collected.push(data);
      setHops([...collected]);

      if (!data.timeout && data.lat && data.lng) {
        pointsRef.current = [...pointsRef.current, data];
        globeRef.current?.pointsData(pointsRef.current);

        const prev = collected.slice(0, -1).reverse().find(h => !h.timeout && h.lat);
        if (prev) {
          arcsRef.current = [...arcsRef.current, { startLat: prev.lat, startLng: prev.lng, endLat: data.lat, endLng: data.lng }];
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

  const startTrace    = () => runTrace(`ws://localhost:8000/trace?target=${target}`);

  // Called automatically when WebRTC discovers the peer's real public IP
  const startTraceToIP = useCallback((ip) => {
    runTrace(`ws://localhost:8000/trace-ip?ip=${ip}`, `📡 Tracing path to your friend (${ip})...`);
    // Switch to trace tab so the user sees the globe animate
    setTab("trace");
  }, [runTrace]);

  // ── WebRTC file transfer — trace auto-fires when peer IP is found ─────────
  const transfer = useFileTransfer({ onPeerIpDiscovered: startTraceToIP });

  const handlePickFile = (e) => {
    const file = e.target.files[0];
    if (file) transfer.sendFile(file);
    e.target.value = "";
  };

  return (
    <div style={{ fontFamily: "'Courier New', monospace", background: "#0d1117", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Header */}
      <div style={{ padding: "12px 24px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", background: "#0d1117", flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontSize: "15px", color: "#58a6ff", letterSpacing: "0.08em" }}>🌐 PACKET PATH VISUALIZER</h1>

        <div className="tab-bar">
          <button className={`tab ${tab === "trace"    ? "active" : ""}`} onClick={() => setTab("trace")}>Trace</button>
          <button className={`tab ${tab === "transfer" ? "active" : ""}`} onClick={() => setTab("transfer")}>Send to Friend</button>
        </div>

        {/* V1 trace controls */}
        {tab === "trace" && (<>
          <select value={target} onChange={e => setTarget(e.target.value)} disabled={tracing}
            style={{ background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: "6px", padding: "6px 10px", fontSize: "13px" }}>
            {TARGETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button onClick={startTrace} disabled={tracing} style={{
            background: tracing ? "#21262d" : "#238636", color: "#fff", border: "none",
            borderRadius: "6px", padding: "8px 18px", cursor: tracing ? "not-allowed" : "pointer",
            fontSize: "13px", fontFamily: "inherit",
          }}>
            {tracing ? "▶ Tracing..." : "▶ Start Trace"}
          </button>
          <span style={{ fontSize: "12px", color: "#8b949e" }}>{traceStatus}</span>
        </>)}

        {/* V2 transfer controls */}
        {tab === "transfer" && (
          <div className="transfer-bar">
            {/* Not yet in a room */}
            {transfer.role === null && (<>
              <button className="btn-primary" onClick={transfer.hostTransfer}>📡 Host a Transfer</button>
              <input className="room-input" placeholder="ROOM CODE" maxLength={6}
                value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
              <button className="btn-secondary" disabled={joinCode.length !== 6}
                onClick={() => transfer.joinTransfer(joinCode)}>🔗 Join</button>
            </>)}

            {/* Host waiting for guest — show the room code prominently */}
            {transfer.role === "host" && transfer.connState === "waiting" && transfer.roomCode && (
              <span className="room-code">Share this code: <b>{transfer.roomCode}</b></span>
            )}

            {/* Both sides connected — host can pick a file */}
            {transfer.connState === "connected" && (<>
              <input ref={fileInputRef} type="file" hidden onChange={handlePickFile} />
              {transfer.role === "host" && (
                <button className="btn-primary" onClick={() => fileInputRef.current.click()}>📤 Choose File to Send</button>
              )}
              {transfer.peerIp && <span className="peer-ip">Peer: {transfer.peerIp}</span>}
            </>)}

            {transfer.role && <button className="btn-ghost" onClick={transfer.reset}>✕ Reset</button>}

            <span style={{ fontSize: "12px", color: "#8b949e" }}>{transfer.statusText}</span>
          </div>
        )}
      </div>

      {/* Globe — always visible */}
      <div ref={globeDivRef} style={{ flex: 1, width: "100%" }} />

      {/* Transfer progress overlay — shows above hop list during transfers */}
      {(transfer.sendProgress !== null || transfer.receiveProgress !== null || transfer.incomingFile) && (
        <div className="transfer-panel">
          {transfer.sendProgress !== null && (
            <div className="progress-row">
              <span>Sending...</span>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${transfer.sendProgress}%` }} /></div>
              <span>{transfer.sendProgress}%</span>
            </div>
          )}
          {transfer.receiveProgress !== null && (
            <div className="progress-row">
              <span>Receiving...</span>
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${transfer.receiveProgress}%` }} /></div>
              <span>{transfer.receiveProgress}%</span>
            </div>
          )}
          {transfer.incomingFile && (
            <div className="progress-row">
              <span>✓ {transfer.incomingFile.name} ({formatBytes(transfer.incomingFile.size)})</span>
              <a className="btn-secondary" href={transfer.incomingFile.url} download={transfer.incomingFile.name}>⬇ Download</a>
            </div>
          )}
        </div>
      )}

      {/* Hop list footer */}
      <div style={{ padding: "6px 24px", borderTop: "1px solid #21262d", display: "flex", gap: "16px", flexWrap: "wrap", background: "#0d1117", flexShrink: 0, minHeight: "32px" }}>
        {hops.map(h => (
          <span key={h.hop} style={{ fontSize: "11px", color: h.timeout ? "#3d444d" : "#00ff88" }}>
            {h.timeout ? `✗ Hop ${h.hop}` : `✓ Hop ${h.hop}: ${h.city}`}
          </span>
        ))}
      </div>
    </div>
  );
}