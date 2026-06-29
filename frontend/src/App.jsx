import { useEffect, useRef, useState, useCallback } from "react";
import Globe from "globe.gl";
import { useFileTransfer } from "./hooks/useFileTransfer";
import "./App.css";

const BACKEND_WS = window.location.hostname === "localhost"
  ? "ws://localhost:8000"
  : `wss://${window.location.host}`;

const CABLE_GEO_URL = "/api/cables";

const TARGETS = [
  { id: "google",     label: "Google DNS", sublabel: "8.8.8.8", flag: "🌐" },
  { id: "cloudflare", label: "Cloudflare DNS", sublabel: "1.1.1.1", flag: "⚡" },
  { id: "london",     label: "London — BBC", sublabel: "United Kingdom", flag: "🇬🇧" },
  { id: "tokyo",      label: "Tokyo — AWS", sublabel: "Japan", flag: "🇯🇵" },
  { id: "new-york",   label: "New York — Fastly", sublabel: "United States", flag: "🇺🇸" },
];

const DEFAULT_STATUS = "Select a destination and start a trace";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${["B","KB","MB","GB"][i]}`;
}

function parseCableGeoJSON(geojson) {
  const paths = [];
  for (const feature of geojson.features) {
    const { color, name } = feature.properties;
    const { type, coordinates } = feature.geometry;
    if (type === "MultiLineString") {
      for (const segment of coordinates) {
        if (segment.length >= 2) paths.push({ coords: segment, color, name });
      }
    } else if (type === "LineString") {
      if (coordinates.length >= 2) paths.push({ coords: coordinates, color, name });
    }
  }
  return paths;
}

function groupHopsByASN(hops) {
  const groups = [];
  for (const hop of hops) {
    const last = groups[groups.length - 1];
    if (last && hop.asn != null && last.asn === hop.asn) {
      last.hops.push(hop);
    } else {
      groups.push({ asn: hop.asn ?? null, org: hop.org ?? null, hops: [hop] });
    }
  }
  return groups;
}

function getRttClass(rtt) {
  if (rtt == null) return "";
  if (rtt < 50)  return "rtt-low";
  if (rtt < 150) return "rtt-medium";
  if (rtt < 300) return "rtt-high";
  return "rtt-very-high";
}

function hopStatusLabel(h) {
  if (h.timeout)     return "Timeout";
  if (h.is_private)  return "Private Network";
  if (h.no_location) return "Reachable (No Geo)";
  return "Reachable";
}

function parseCityCountry(cityStr) {
  if (!cityStr) return { city: null, country: null };
  const withoutIsp = cityStr.replace(/\s*\[.*?\]\s*$/, "");
  const parts = withoutIsp.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], country: parts[parts.length - 1] };
  return { city: parts[0] || cityStr, country: null };
}

const EARTH_RADIUS_KM = 6371;

function haversineDistanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inferExitPoint(hops) {
  const withCountry = hops
    .filter(h => h.lat != null && h.lng != null)
    .map(h => ({ hop: h, country: parseCityCountry(h.city).country }))
    .filter(entry => entry.country);

  if (withCountry.length === 0) return null;

  const originCountry = withCountry[0].country;
  let lastInOrigin = null;
  let leftOrigin = false;

  for (const entry of withCountry) {
    if (entry.country === originCountry) {
      lastInOrigin = entry.hop;
    } else {
      leftOrigin = true;
      break;
    }
  }

  return leftOrigin ? lastInOrigin : null;
}

function generateSummary(hops) {
  if (!hops || hops.length === 0) return null;

  const totalHops   = hops.length;
  const privateHops = hops.filter(h => h.is_private).length;
  const timeoutHops = hops.filter(h => h.timeout).length;
  const publicHops  = totalHops - privateHops - timeoutHops;

  const rtts   = hops.map(h => h.rtt).filter(r => r != null);
  const minRtt = rtts.length ? Math.min(...rtts) : null;
  const maxRtt = rtts.length ? Math.max(...rtts) : null;
  const avgRtt = rtts.length
    ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10
    : null;

  const uniqueASNs      = new Set(hops.map(h => h.asn).filter(v => v != null)).size;
  const uniqueOrgs       = new Set(hops.map(h => h.org).filter(Boolean)).size;
  const uniqueCountries = new Set(
    hops.map(h => parseCityCountry(h.city).country).filter(Boolean)
  ).size;

  const geoHops = hops.filter(h => h.lat != null && h.lng != null);
  let distanceKm = 0;
  for (let i = 1; i < geoHops.length; i++) {
    distanceKm += haversineDistanceKm(geoHops[i - 1], geoHops[i]);
  }

  return {
    totalHops, publicHops, privateHops, timeoutHops,
    minRtt, maxRtt, avgRtt,
    uniqueASNs, uniqueOrgs, uniqueCountries,
    distanceKm: Math.round(distanceKm),
    exitPoint: inferExitPoint(hops),
  };
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

  const selectedHopRef = useRef(null);
  const selectHopRef   = useRef(null);

  const [hops, setHops]                 = useState([]);
  const [traceStatus, setTraceStatus]   = useState(DEFAULT_STATUS);
  const [tracing, setTracing]           = useState(false);
  const [target, setTarget]             = useState("google");
  const [view, setView]                 = useState("home");
  const [showCableInfo, setShowCableInfo] = useState(false);
  const [joinCode, setJoinCode]         = useState("");
  const [cablesLoaded, setCablesLoaded] = useState(false);
  const [selectedHop, setSelectedHop]   = useState(null);
  const [summary, setSummary]           = useState(null);
  const [theme, setTheme]               = useState("dark");   // ← NEW
  const fileInputRef = useRef(null);

  // ── Apply theme to <html> element ─────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ── Globe init (runs once) ─────────────────────────────────────────────────
  useEffect(() => {
    if (globeRef.current) return;
    const g = Globe()(globeDivRef.current);

    g.globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
     .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
     .atmosphereColor("#1a8cff").atmosphereAltitude(0.15)

     .pointsData([])
     .pointLat("lat")
     .pointLng("lng")
     .pointColor(d => d.hop === selectedHopRef.current?.hop ? "#1d0aaa" : "#3b82f6")
     .pointAltitude(0.01)
     .pointRadius(d => d.hop === selectedHopRef.current?.hop ? 0.65 : 0.4)
     .onPointClick(point => { selectHopRef.current?.(point); })
     .pointLabel(d => `
       <div style="
         background:#0d1b2e;color:#e2e8f0;
         padding:10px 14px;border-radius:10px;
         font-family:-apple-system,sans-serif;font-size:12px;
         border:1px solid #1e3a5f;line-height:1.6;
         min-width:190px;box-shadow:0 6px 20px rgba(0,0,0,0.6)">
         <div style="display:flex;align-items:center;justify-content:space-between;
                     margin-bottom:7px;padding-bottom:7px;border-bottom:1px solid #1e293b">
           <b style="color:#60a5fa;font-size:13px">Hop ${d.hop}</b>
           ${d.rtt != null
             ? `<span style="font-size:11px;padding:2px 8px;border-radius:4px;
                             background:rgba(34,197,94,0.15);color:#22c55e;
                             font-weight:600;font-family:monospace">${d.rtt} ms</span>`
             : ""}
         </div>
         <div style="font-family:monospace;font-size:11px;color:#64748b;margin-bottom:3px">
           ${d.ip || ""}
         </div>
         <div style="color:#cbd5e1;font-size:12px;margin-bottom:5px">
           ${d.city || ""}
         </div>
         ${d.asn
           ? `<div style="font-size:10px;color:#475569;font-family:monospace">
                AS${d.asn}${d.org ? " · " + d.org : ""}
              </div>`
           : ""}
       </div>
     `)

     .arcsData([])
     .arcStartLat("startLat").arcStartLng("startLng")
     .arcEndLat("endLat").arcEndLng("endLng")
     .arcColor(() => "#3b82f6")
     .arcAltitude(0.3).arcStroke(0.5)
     .arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(1500)

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

  // ── Keep selectedHopRef in sync ───────────────────────────────────────────
  useEffect(() => {
    selectedHopRef.current = selectedHop;
    if (globeRef.current && pointsRef.current.length > 0) {
      globeRef.current.pointsData([...pointsRef.current]);
    }
  }, [selectedHop]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (!hops.length) return;
      e.preventDefault();

      setSelectedHop(prev => {
        const currentIdx = prev ? hops.findIndex(h => h.hop === prev.hop) : -1;
        const nextIdx = e.key === "ArrowDown"
          ? (currentIdx < hops.length - 1 ? currentIdx + 1 : 0)
          : (currentIdx > 0 ? currentIdx - 1 : hops.length - 1);

        const next = hops[nextIdx];
        if (next?.lat && next?.lng) {
          globeRef.current?.pointOfView({ lat: next.lat, lng: next.lng, altitude: 1.5 }, 800);
        }
        return next;
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hops]);

  // ── Clear trace ────────────────────────────────────────────────────────────
  const clearTrace = useCallback(() => {
    setHops([]);
    setSelectedHop(null);
    setSummary(null);
    pointsRef.current = [];
    arcsRef.current   = [];
    globeRef.current?.pointsData([]);
    globeRef.current?.arcsData([]);
    setTraceStatus(DEFAULT_STATUS);
  }, []);

  // ── Select a hop ──────────────────────────────────────────────────────────
  const selectHop = useCallback((hop) => {
    setSelectedHop(prev => {
      const next = prev?.hop === hop.hop ? null : hop;
      if (next && hop?.lat && hop?.lng) {
        globeRef.current?.pointOfView({ lat: hop.lat, lng: hop.lng, altitude: 1.5 }, 800);
      }
      return next;
    });
  }, []);
  selectHopRef.current = selectHop;

  // ── Shared traceroute runner ───────────────────────────────────────────────
  const runTrace = useCallback((wsUrl, label) => {
    tracingRef.current = true;
    setTracing(true);
    setHops([]);
    setSelectedHop(null);
    setSummary(null);
    setTraceStatus(label || "Tracing...");
    setView("trace");
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
        setSummary(generateSummary(collected));
        setTracing(false); tracingRef.current = false;
        relayHopRef.current?.({ done: true, total: collected.length, located });
        ws.close();
        return;
      }

      collected.push(data);
      setHops([...collected]);
      relayHopRef.current?.(data);

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
      setView("trace");
      return;
    }
    runTrace(`${BACKEND_WS}/trace-ip?ip=${ip}`, `Tracing path to peer (${ip})...`);
  }, [runTrace]);

  const handleRelayedHop = useCallback((data) => {
    if (data.reset) {
      relayedHopsRef.current = [];
      pointsRef.current = [];
      arcsRef.current   = [];
      globeRef.current?.pointsData([]);
      globeRef.current?.arcsData([]);
      setHops([]);
      setSelectedHop(null);
      setSummary(null);
      setTraceStatus("Receiving route trace from host...");
      setView("trace");
      return;
    }

    if (data.done) {
      setTraceStatus(`Trace complete — ${data.total} hops, ${data.located} located`);
      setSummary(generateSummary(relayedHopsRef.current));
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

  // ── Hop card CSS class ─────────────────────────────────────────────────────
  const hopCardClass = (h) => {
    let cls = "hop-card";
    if (h.timeout)          cls += " hop-warn";
    else if (h.is_private)  cls += " hop-internal";
    else if (h.no_location) cls += " hop-nogeo";
    else                    cls += " hop-ok";
    if (selectedHop?.hop === h.hop) cls += " selected";
    return cls;
  };

  const renderHopCard = (h) => (
    <div key={h.hop} className={hopCardClass(h)} onClick={() => selectHop(h)}>
      <span className="hop-number">{h.hop}</span>
      <div className="hop-info">
        {h.timeout ? (
          <>
            <div className="hop-city" style={{ color: "#64748b" }}>No Response</div>
            <div className="hop-ip">Request timed out</div>
          </>
        ) : (
          <>
            <div className="hop-city">{h.city}</div>
            {h.ip && <div className="hop-ip">{h.ip}</div>}
            <div className="hop-extended-grid">
              <span className="hop-detail-label">Host</span>
              <span className="hop-detail-value">{h.hostname || "—"}</span>
              <span className="hop-detail-label">ASN</span>
              <span className="hop-detail-value">{h.asn ? `AS${h.asn}` : "—"}</span>
              <span className="hop-detail-label">Org</span>
              <span className="hop-detail-value">{h.org || "—"}</span>
              <span className="hop-detail-label">RTT</span>
              <span className={`hop-detail-value ${getRttClass(h.rtt)}`}>
                {h.rtt != null ? `${h.rtt} ms` : "—"}
              </span>
            </div>
          </>
        )}
      </div>
      {h.timeout ? (
        <span className="hop-badge hop-badge-warn">TIMEOUT</span>
      ) : h.is_private ? (
        <span className="hop-badge hop-badge-internal">PRIVATE</span>
      ) : h.no_location ? (
        <span className="hop-badge hop-badge-nogeo">NO GEO</span>
      ) : (
        <span className="hop-badge hop-badge-ok">OK</span>
      )}
    </div>
  );

  // ── View: Home ─────────────────────────────────────────────────────────────
  const renderHome = () => (
    <div className="view-home">
      <div className="home-hero">
        <div className="home-logo">
          <span className="home-logo-icon">⊶</span>
        </div>
        <h1 className="home-title">Packet Path Visualizer</h1>
        <p className="home-subtitle">
          Visualize your internet route in real time — see every hop, latency, and submarine cable between you and the destination.
        </p>
      </div>

      <div className="home-actions">
        <button className="home-card" onClick={() => setView("trace")}>
          <div className="home-card-icon-wrap home-card-icon--trace">
            <span className="home-card-icon">🛰️</span>
          </div>
          <div className="home-card-body">
            <span className="home-card-title">Trace Server Routes</span>
            <span className="home-card-desc">Map the network path to major internet destinations worldwide</span>
          </div>
          <span className="home-card-arrow">→</span>
        </button>

        <button className="home-card" onClick={() => setView("transfer")}>
          <div className="home-card-icon-wrap home-card-icon--transfer">
            <span className="home-card-icon">📡</span>
          </div>
          <div className="home-card-body">
            <span className="home-card-title">Send File to Friend</span>
            <span className="home-card-desc">Transfer files peer-to-peer and trace the route between you</span>
          </div>
          <span className="home-card-arrow">→</span>
        </button>
      </div>

      <div className="home-footer">
        <div className="home-stat">
          <span className="home-stat-dot home-stat-dot--cable" />
          Submarine cables overlaid
        </div>
        <div className="home-stat">
          <span className="home-stat-dot home-stat-dot--live" />
          Live traceroute
        </div>
      </div>
    </div>
  );

  // ── View: Trace ────────────────────────────────────────────────────────────
  const renderTrace = () => (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={() => { clearTrace(); setView("home"); }}>
          ← Back
        </button>
        <span className="view-header-title">Route Trace</span>
        <span className="live-badge">LIVE</span>
      </div>

      <div className="control-section">
        <label className="field-label">Destination</label>
        <div className="target-grid">
          {TARGETS.map(t => (
            <button
              key={t.id}
              className={`target-chip ${target === t.id ? "target-chip--active" : ""}`}
              onClick={() => setTarget(t.id)}
              disabled={tracing}
            >
              <span className="target-chip-flag">{t.flag}</span>
              <span className="target-chip-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="action-row">
          <button className="btn-primary btn-primary--wide" onClick={startTrace} disabled={tracing}>
            {tracing ? (
              <>
                <span className="btn-spinner" />
                Tracing…
              </>
            ) : (
              "▶  Start Trace"
            )}
          </button>
          <button className="btn-ghost-sm" onClick={clearTrace} disabled={tracing}>
            Clear
          </button>
        </div>

        <div className={`status-chip ${tracing ? "status-chip--active" : ""}`}>
          {tracing && <span className="status-pulse" />}
          {traceStatus}
        </div>
      </div>

      {/* Hop detail panel */}
      {selectedHop && (
        <div className="detail-panel">
          <div className="detail-panel-header">
            <span className="detail-panel-label">Hop {selectedHop.hop} — Details</span>
            <button className="detail-panel-close" onClick={() => setSelectedHop(null)}>✕</button>
          </div>
          <div className="detail-panel-grid">
            <span className="detail-key">Status</span>
            <span className="detail-val detail-val--status">{hopStatusLabel(selectedHop)}</span>
            <span className="detail-key">IP</span>
            <span className="detail-val">{selectedHop.ip || "—"}</span>
            <span className="detail-key">Hostname</span>
            <span className="detail-val">{selectedHop.hostname || "—"}</span>
            <span className="detail-key">RTT</span>
            <span className={`detail-val ${getRttClass(selectedHop.rtt)}`}>
              {selectedHop.rtt != null ? `${selectedHop.rtt} ms` : "—"}
            </span>
            <span className="detail-key">ASN</span>
            <span className="detail-val">{selectedHop.asn ? `AS${selectedHop.asn}` : "—"}</span>
            <span className="detail-key">Org</span>
            <span className="detail-val">{selectedHop.org || "—"}</span>
            <span className="detail-key">Location</span>
            <span className="detail-val">{selectedHop.city || "—"}</span>
            <span className="detail-key">Coords</span>
            <span className="detail-val">
              {selectedHop.lat != null
                ? `${selectedHop.lat.toFixed(3)}, ${selectedHop.lng.toFixed(3)}`
                : "—"}
            </span>
          </div>
        </div>
      )}

      {/* Summary CTA */}
      {summary && !tracing && (
        <div className="summary-cta">
          <button className="btn-summary-cta" onClick={() => setView("summary")}>
            <span>📊</span>
            View Trace Summary
            <span className="summary-cta-arrow">→</span>
          </button>
        </div>
      )}

      {/* Hop log */}
      <div className="hop-log">
        {hops.length === 0 ? (
          <div className="hop-log-empty">
            <span className="hop-log-empty-icon">📡</span>
            <span>No hops yet. Choose a destination above and start the trace.</span>
          </div>
        ) : (
          <>
            <div className="hop-log-header">
              <span className="hop-log-title">Network Path</span>
              <span className="hop-count-badge">{hops.length} hops</span>
            </div>

            {groupHopsByASN(hops).map((group, gIdx) => {
              const isAsnGroup = group.asn != null && group.hops.length >= 2;

              if (!isAsnGroup) {
                return group.hops.map(h => renderHopCard(h));
              }

              return (
                <div key={`asn-${gIdx}`} className="asn-group">
                  <div className="asn-group-header">
                    <span className="asn-group-name">
                      {group.org || `AS${group.asn}`}
                    </span>
                    <span className="asn-group-badge">
                      AS{group.asn} · {group.hops.length} hops
                    </span>
                  </div>
                  {group.hops.map(h => renderHopCard(h))}
                </div>
              );
            })}

            <div className="hop-log-kb-hint">↑ ↓ to navigate · click to inspect</div>
          </>
        )}
      </div>
    </div>
  );

  // ── View: Transfer ─────────────────────────────────────────────────────────
  const renderTransfer = () => (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={() => setView("home")}>
          ← Back
        </button>
        <span className="view-header-title">P2P File Transfer</span>
      </div>

      <div className="control-section">
        {transfer.role === null && (
          <>
            <label className="field-label">Start a session or join one</label>
            <button className="btn-primary btn-primary--wide" onClick={transfer.hostTransfer}>
              📡  Host a Transfer
            </button>
            <div className="divider-row">
              <span className="divider-line" />
              <span className="divider-text">or join with code</span>
              <span className="divider-line" />
            </div>
            <div className="join-row">
              <input
                className="room-input"
                placeholder="XXXXXX"
                maxLength={6}
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
              />
              <button
                className="btn-primary"
                disabled={joinCode.length !== 6}
                onClick={() => transfer.joinTransfer(joinCode)}
              >
                Join
              </button>
            </div>
          </>
        )}

        {transfer.role === "host" && transfer.connState === "waiting" && transfer.roomCode && (
          <div className="room-code-display">
            <label className="field-label">Share this code with your friend</label>
            <div className="room-code-box">
              <span className="room-code-value">{transfer.roomCode}</span>
            </div>
            <p className="room-code-hint">Waiting for peer to connect…</p>
            <button className="btn-ghost-sm" style={{ marginTop: "8px" }} onClick={transfer.reset}>Cancel</button>
          </div>
        )}

        {transfer.connState === "connected" && (
          <div className="connected-panel">
            <div className="connected-indicator">
              <span className="peer-ip-dot" />
              <span className="connected-label">Connected</span>
              {transfer.peerIp && (
                <span className="peer-ip-value">{transfer.peerIp}</span>
              )}
            </div>

            {transfer.role === "host" && (
              <>
                <input ref={fileInputRef} type="file" hidden onChange={handlePickFile} />
                <button className="btn-primary btn-primary--wide" onClick={() => fileInputRef.current.click()}>
                  📤  Choose File to Send
                </button>
              </>
            )}

            <button className="btn-ghost-sm" onClick={transfer.reset}>
              Disconnect
            </button>
          </div>
        )}

        {transfer.incomingFile && (
          <div className="download-card">
            <span className="download-icon">⬇</span>
            <div className="download-info">
              <span className="download-name">{transfer.incomingFile.name}</span>
              <span className="download-size">{formatBytes(transfer.incomingFile.size)}</span>
            </div>
            <a className="btn-primary" href={transfer.incomingFile.url} download={transfer.incomingFile.name}>
              Save
            </a>
          </div>
        )}

        {transfer.role && transfer.connState !== "connected" && transfer.connState !== "waiting" && (
          <button className="btn-ghost-sm" onClick={transfer.reset}>← Reset</button>
        )}

        <div className={`status-chip ${transfer.statusText ? "status-chip--active" : ""}`}>
          {transfer.statusText || "Idle"}
        </div>
      </div>

      {/* Transfer progress */}
      {(transfer.sendProgress !== null || transfer.receiveProgress !== null) && (
        <div className="progress-section">
          {transfer.sendProgress !== null && (
            <div className="progress-row">
              <span className="progress-label">Sending</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${transfer.sendProgress}%` }} />
              </div>
              <span className="progress-pct">{transfer.sendProgress}%</span>
            </div>
          )}
          {transfer.receiveProgress !== null && (
            <div className="progress-row">
              <span className="progress-label">Receiving</span>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${transfer.receiveProgress}%` }} />
              </div>
              <span className="progress-pct">{transfer.receiveProgress}%</span>
            </div>
          )}
        </div>
      )}

      {/* Relayed hop log for guest */}
      {hops.length > 0 && (
        <>
          <div className="hop-log-header" style={{ padding: "0 22px", marginTop: "8px" }}>
            <span className="hop-log-title">Route from Host</span>
            <span className="hop-count-badge">{hops.length} hops</span>
          </div>
          <div className="hop-log">
            {groupHopsByASN(hops).map((group, gIdx) => {
              const isAsnGroup = group.asn != null && group.hops.length >= 2;
              if (!isAsnGroup) return group.hops.map(h => renderHopCard(h));
              return (
                <div key={`asn-${gIdx}`} className="asn-group">
                  <div className="asn-group-header">
                    <span className="asn-group-name">{group.org || `AS${group.asn}`}</span>
                    <span className="asn-group-badge">AS{group.asn} · {group.hops.length} hops</span>
                  </div>
                  {group.hops.map(h => renderHopCard(h))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  // ── View: Summary ──────────────────────────────────────────────────────────
  const renderSummary = () => (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={() => setView("trace")}>
          ← Hop Log
        </button>
        <span className="view-header-title">Trace Summary</span>
      </div>

      {summary && (
        <div className="summary-view">
          <div className="summary-section">
            <div className="summary-section-title">Hops</div>
            <div className="summary-kpi-grid">
              <div className="summary-kpi">
                <span className="summary-kpi-val">{summary.totalHops}</span>
                <span className="summary-kpi-label">Total</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--ok">{summary.publicHops}</span>
                <span className="summary-kpi-label">Public</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--int">{summary.privateHops}</span>
                <span className="summary-kpi-label">Private</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--warn">{summary.timeoutHops}</span>
                <span className="summary-kpi-label">Timeouts</span>
              </div>
            </div>
          </div>

          <div className="summary-section">
            <div className="summary-section-title">Latency</div>
            <div className="summary-kpi-grid">
              <div className="summary-kpi">
                <span className={`summary-kpi-val ${getRttClass(summary.minRtt)}`}>
                  {summary.minRtt != null ? `${summary.minRtt}` : "—"}
                </span>
                <span className="summary-kpi-label">Min ms</span>
              </div>
              <div className="summary-kpi">
                <span className={`summary-kpi-val ${getRttClass(summary.avgRtt)}`}>
                  {summary.avgRtt != null ? `${summary.avgRtt}` : "—"}
                </span>
                <span className="summary-kpi-label">Avg ms</span>
              </div>
              <div className="summary-kpi">
                <span className={`summary-kpi-val ${getRttClass(summary.maxRtt)}`}>
                  {summary.maxRtt != null ? `${summary.maxRtt}` : "—"}
                </span>
                <span className="summary-kpi-label">Max ms</span>
              </div>
            </div>
          </div>

          <div className="summary-section">
            <div className="summary-section-title">Network Coverage</div>
            <div className="summary-kpi-grid">
              <div className="summary-kpi">
                <span className="summary-kpi-val">{summary.uniqueASNs}</span>
                <span className="summary-kpi-label">ASNs</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val">{summary.uniqueOrgs}</span>
                <span className="summary-kpi-label">Orgs</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val">{summary.uniqueCountries}</span>
                <span className="summary-kpi-label">Countries</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val">
                  {summary.distanceKm ? `${summary.distanceKm.toLocaleString()}` : "—"}
                </span>
                <span className="summary-kpi-label">km (geo)</span>
              </div>
            </div>
          </div>

          <div className="summary-section">
            <div className="summary-section-title">International Exit Point</div>
            <div className="summary-exit-card">
              {summary.exitPoint ? (
                <>
                  <span className="summary-exit-city">
                    {parseCityCountry(summary.exitPoint.city).city || summary.exitPoint.city}
                  </span>
                  <span className="summary-exit-ip">{summary.exitPoint.ip || "—"}</span>
                </>
              ) : (
                <span className="summary-exit-unknown">
                  Unknown — trace may not have left origin country
                </span>
              )}
            </div>
          </div>

          <div className="summary-disclaimer">
            🌊 Exact cable route cannot be determined via traceroute. Submarine cable overlay is shown for geographic context only.
          </div>
        </div>
      )}
    </div>
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">

      {/* Globe pane */}
      <div className="globe-section">
        <div ref={globeDivRef} className="globe-canvas" />

        {!cablesLoaded && (
          <div className="cable-loading">
            <span className="cable-loading-dot" />
            Loading submarine cables…
          </div>
        )}

        {/* Info button */}
        <button
          className="globe-info-btn"
          onClick={() => setShowCableInfo(v => !v)}
          title="About submarine cable overlay"
        >
          ℹ
        </button>
        {showCableInfo && (
          <div className="globe-info-popover">
            <button className="globe-info-popover-close" onClick={() => setShowCableInfo(false)}>✕</button>
            <p>Exact cable cannot be determined using traceroute. Submarine cable overlay is shown for geographic context.</p>
          </div>
        )}

        {/* Transfer progress overlay */}
        {(transfer.sendProgress !== null || transfer.receiveProgress !== null) && (
          <div className="transfer-panel">
            {transfer.sendProgress !== null && (
              <div className="progress-row">
                <span className="progress-label">Sending</span>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${transfer.sendProgress}%` }} />
                </div>
                <span className="progress-pct">{transfer.sendProgress}%</span>
              </div>
            )}
            {transfer.receiveProgress !== null && (
              <div className="progress-row">
                <span className="progress-label">Receiving</span>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${transfer.receiveProgress}%` }} />
                </div>
                <span className="progress-pct">{transfer.receiveProgress}%</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-wordmark">
          <span className="wordmark-dot" />
          Packet Path Visualizer

          {/* ── Theme toggle ── */}
          <div className="theme-toggle" role="group" aria-label="Theme">
            <button
              className={`theme-btn ${theme === "dark" ? "theme-btn--active" : ""}`}
              onClick={() => setTheme("dark")}
              title="Dark mode"
              aria-pressed={theme === "dark"}
            >
              🌙
            </button>
            <button
              className={`theme-btn ${theme === "light" ? "theme-btn--active" : ""}`}
              onClick={() => setTheme("light")}
              title="Light mode"
              aria-pressed={theme === "light"}
            >
              ☀️
            </button>
          </div>
        </div>

        <div className="sidebar-scroll">
          {view === "home"     && renderHome()}
          {view === "trace"    && renderTrace()}
          {view === "transfer" && renderTransfer()}
          {view === "summary"  && renderSummary()}
        </div>
      </div>
    </div>
  );
}