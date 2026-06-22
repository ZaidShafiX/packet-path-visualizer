import { useEffect, useRef, useState } from "react";
import Globe from "globe.gl";

const TARGETS = [
  { id: "google",     label: "🌐 Google DNS (8.8.8.8)" },
  { id: "cloudflare", label: "⚡ Cloudflare DNS (1.1.1.1)" },
  { id: "london",     label: "🇬🇧 London — BBC" },
  { id: "tokyo",      label: "🇯🇵 Tokyo — AWS" },
  { id: "new-york",   label: "🇺🇸 New York — Fastly" },
];

export default function App() {
  const globeDivRef = useRef(null);
  const globeRef    = useRef(null);
  const [hops, setHops]       = useState([]);
  const [status, setStatus]   = useState("Pick a destination and hit Start Trace");
  const [tracing, setTracing] = useState(false);
  const [target, setTarget]   = useState("google");

  // Points and arcs stored in refs so globe can read latest values
  const pointsRef = useRef([]);
  const arcsRef   = useRef([]);

  useEffect(() => {
    // Initialize the globe once
    const globe = Globe()(globeDivRef.current);

    globe
      .globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
      .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
      .atmosphereColor("#1a8cff")
      .atmosphereAltitude(0.15)
      // Points (hop dots)
      .pointsData([])
      .pointLat("lat")
      .pointLng("lng")
      .pointColor(() => "#00ff88")
      .pointAltitude(0.01)
      .pointRadius(0.4)
      .pointLabel(d => `<div style="background:#0d1117;color:#00ff88;padding:6px 10px;border-radius:6px;font-family:monospace;font-size:12px;border:1px solid #00ff88">
        <b>Hop ${d.hop}</b><br/>${d.city}<br/><span style="color:#8b949e">${d.ip || ""}</span>
      </div>`)
      // Arcs (curved paths between hops)
      .arcsData([])
      .arcStartLat("startLat")
      .arcStartLng("startLng")
      .arcEndLat("endLat")
      .arcEndLng("endLng")
      .arcColor(() => "#00ff88")
      .arcAltitude(0.3)
      .arcStroke(0.5)
      .arcDashLength(0.4)
      .arcDashGap(0.2)
      .arcDashAnimateTime(1500);

    // Size globe to fill container
    globe.width(globeDivRef.current.clientWidth);
    globe.height(globeDivRef.current.clientHeight);

    // Start with a nice view angle
    globe.pointOfView({ lat: 30, lng: 50, altitude: 2 }, 0);

    globeRef.current = globe;

    const handleResize = () => {
      globe.width(globeDivRef.current.clientWidth);
      globe.height(globeDivRef.current.clientHeight);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const startTrace = () => {
    if (tracing) return;
    setTracing(true);
    setHops([]);
    setStatus("Tracing...");

    // Clear previous data
    pointsRef.current = [];
    arcsRef.current   = [];
    globeRef.current.pointsData([]);
    globeRef.current.arcsData([]);

    const ws = new WebSocket(`ws://localhost:8000/trace?target=${target}`);
    const collectedHops = [];

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.error) {
        setStatus(`Error: ${data.error}`);
        setTracing(false);
        return;
      }

      if (data.done) {
        const located = collectedHops.filter(h => !h.timeout).length;
        setStatus(`Trace complete — ${collectedHops.length} hops, ${located} located`);
        setTracing(false);
        ws.close();
        return;
      }

      collectedHops.push(data);
      setHops([...collectedHops]);

      if (!data.timeout && data.lat && data.lng) {
        // Add point for this hop
        pointsRef.current = [...pointsRef.current, data];
        globeRef.current.pointsData(pointsRef.current);

        // Find previous located hop and draw an arc
        const prevLocated = collectedHops
          .slice(0, -1)
          .reverse()
          .find(h => !h.timeout && h.lat);

        if (prevLocated) {
          const arc = {
            startLat: prevLocated.lat,
            startLng: prevLocated.lng,
            endLat:   data.lat,
            endLng:   data.lng,
          };
          arcsRef.current = [...arcsRef.current, arc];
          globeRef.current.arcsData(arcsRef.current);
        }

        // Smoothly rotate the globe to show the new hop
        globeRef.current.pointOfView(
          { lat: data.lat, lng: data.lng, altitude: 2 },
          1000  // 1 second transition
        );
      }
    };

    ws.onerror = () => {
      setStatus("Error: could not connect to backend. Is it running?");
      setTracing(false);
    };
  };

  return (
    <div style={{ fontFamily: "'Courier New', monospace", background: "#0d1117", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{
        padding: "12px 24px",
        borderBottom: "1px solid #21262d",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        flexWrap: "wrap",
        background: "#0d1117",
        zIndex: 10,
        flexShrink: 0,
      }}>
        <h1 style={{ margin: 0, fontSize: "15px", color: "#58a6ff", letterSpacing: "0.08em" }}>
          🌐 PACKET PATH VISUALIZER
        </h1>

        <select
          value={target}
          onChange={e => setTarget(e.target.value)}
          disabled={tracing}
          style={{
            background: "#161b22", color: "#c9d1d9",
            border: "1px solid #30363d", borderRadius: "6px",
            padding: "6px 10px", fontSize: "13px", cursor: "pointer",
          }}
        >
          {TARGETS.map(t => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>

        <button
          onClick={startTrace}
          disabled={tracing}
          style={{
            background: tracing ? "#21262d" : "#238636",
            color: "#fff", border: "none", borderRadius: "6px",
            padding: "8px 18px", cursor: tracing ? "not-allowed" : "pointer",
            fontSize: "13px", fontFamily: "inherit",
          }}
        >
          {tracing ? "▶ Tracing..." : "▶ Start Trace"}
        </button>

        <span style={{ fontSize: "12px", color: "#8b949e" }}>{status}</span>
      </div>

      {/* Globe */}
      <div ref={globeDivRef} style={{ flex: 1, width: "100%" }} />

      {/* Hop list */}
      <div style={{
        padding: "6px 24px",
        borderTop: "1px solid #21262d",
        display: "flex", gap: "16px", flexWrap: "wrap",
        background: "#0d1117", flexShrink: 0, minHeight: "32px",
      }}>
        {hops.map((h) => (
          <span key={h.hop} style={{ fontSize: "11px", color: h.timeout ? "#3d444d" : "#00ff88" }}>
            {h.timeout ? `✗ Hop ${h.hop}` : `✓ Hop ${h.hop}: ${h.city}`}
          </span>
        ))}
      </div>
    </div>
  );
}