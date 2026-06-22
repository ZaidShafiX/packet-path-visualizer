import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const TARGETS = [
  { id: "google",     label: "🌐 Google DNS (8.8.8.8)" },
  { id: "cloudflare", label: "⚡ Cloudflare DNS (1.1.1.1)" },
  { id: "london",     label: "🇬🇧 London — BBC" },
  { id: "tokyo",      label: "🇯🇵 Tokyo — AWS" },
  { id: "new-york",   label: "🇺🇸 New York — Fastly" },
];

export default function App() {
  const mapRef    = useRef(null);
  const mapDivRef = useRef(null);
  const [hops, setHops]       = useState([]);
  const [status, setStatus]   = useState("Pick a destination and hit Start Trace");
  const [tracing, setTracing] = useState(false);
  const [target, setTarget]   = useState("google");

  useEffect(() => {
    if (mapRef.current) return;
    mapRef.current = L.map(mapDivRef.current, { center: [30, 30], zoom: 2 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
    }).addTo(mapRef.current);
  }, []);

  const startTrace = () => {
    if (tracing) return;
    setTracing(true);
    setHops([]);
    setStatus("Tracing...");

    // Clear old markers and lines
    mapRef.current.eachLayer((layer) => {
      if (layer instanceof L.CircleMarker || layer instanceof L.Polyline) {
        mapRef.current.removeLayer(layer);
      }
    });

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

      // Only draw on map if we have real coordinates
      if (!data.timeout && data.lat && data.lng) {
        L.circleMarker([data.lat, data.lng], {
          radius: 7,
          color: "#00ff88",
          fillColor: "#00ff88",
          fillOpacity: 0.9,
        })
          .bindTooltip(`Hop ${data.hop}: ${data.city}`, { permanent: false })
          .addTo(mapRef.current);

        // Draw line from previous located hop to this one
        const prevLocated = collectedHops
          .slice(0, -1)
          .reverse()
          .find(h => !h.timeout && h.lat);

        if (prevLocated) {
          L.polyline(
            [[prevLocated.lat, prevLocated.lng], [data.lat, data.lng]],
            { color: "#00ff88", weight: 2, opacity: 0.7, dashArray: "6, 6" }
          ).addTo(mapRef.current);
        }
      }
    };

    ws.onerror = () => {
      setStatus("Error: could not connect to backend. Is it running?");
      setTracing(false);
    };
  };

  return (
    <div style={{ fontFamily: "monospace", background: "#0d1117", minHeight: "100vh", color: "#c9d1d9" }}>
      {/* Header */}
      <div style={{ padding: "12px 24px", borderBottom: "1px solid #21262d", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: "16px", color: "#58a6ff" }}>🌐 Packet Path Visualizer</h1>

        <select
          value={target}
          onChange={e => setTarget(e.target.value)}
          disabled={tracing}
          style={{ background: "#161b22", color: "#c9d1d9", border: "1px solid #30363d", borderRadius: "6px", padding: "6px 10px", fontSize: "13px" }}
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
            padding: "8px 16px", cursor: tracing ? "not-allowed" : "pointer", fontSize: "13px",
          }}
        >
          {tracing ? "Tracing..." : "▶ Start Trace"}
        </button>

        <span style={{ fontSize: "12px", color: "#8b949e" }}>{status}</span>
      </div>

      {/* Map */}
      <div ref={mapDivRef} style={{ height: "calc(100vh - 100px)", width: "100%" }} />

      {/* Hop list at bottom */}
      <div style={{ padding: "6px 24px", borderTop: "1px solid #21262d", display: "flex", gap: "16px", flexWrap: "wrap", background: "#0d1117" }}>
        {hops.map((h) => (
          <span key={h.hop} style={{ fontSize: "11px", color: h.timeout ? "#6e7681" : "#00ff88" }}>
            Hop {h.hop}: {h.city}
          </span>
        ))}
      </div>
    </div>
  );
}