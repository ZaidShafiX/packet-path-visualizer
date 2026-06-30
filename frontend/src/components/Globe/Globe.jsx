/**
 * components/Globe/Globe.jsx
 * ===========================
 * Three.js / WebGL globe rendering via globe.gl.
 *
 * Responsibilities
 * ----------------
 * - Initialises the globe.gl instance on mount (once).
 * - Fetches and applies the submarine cable overlay via CableOverlay helpers.
 * - Exposes globeRef, pointsRef, arcsRef to the parent via an imperative
 *   ref (forwardRef / useImperativeHandle is avoided — the parent simply
 *   passes the three refs in as props so this stays a plain component).
 * - Shows a loading badge while cables are being fetched.
 * - Shows an info popover (toggled by the ℹ button).
 * - Renders the transfer-progress overlay panel at the bottom of the globe.
 *
 * Props
 * -----
 * globeRef       {React.RefObject}  – written to on mount
 * pointsRef      {React.RefObject}  – hop point array ref
 * arcsRef        {React.RefObject}  – hop arc array ref
 * selectedHopRef {React.RefObject}  – currently selected hop (for point colour)
 * onPointClick   {Function}         – called with a point datum on click
 * sendProgress   {number|null}
 * receiveProgress {number|null}
 */

import { useEffect, useRef, useState } from "react";
import GlobeGL from "globe.gl";
import { parseCableGeoJSON } from "./CableOverlay";
import ProgressBar from "../shared/ProgressBar";

const CABLE_GEO_URL = "/api/cables";

export default function Globe({
  globeRef,
  pointsRef,
  arcsRef,
  selectedHopRef,
  onPointClick,
  sendProgress,
  receiveProgress,
}) {
  const containerRef    = useRef(null);
  const [cablesLoaded, setCablesLoaded]   = useState(false);
  const [showCableInfo, setShowCableInfo] = useState(false);

  // ── Globe init (runs once) ────────────────────────────────────────────────
  useEffect(() => {
    if (globeRef.current) return;

    const g = GlobeGL()(containerRef.current);

    g.globeImageUrl("//unpkg.com/three-globe/example/img/earth-night.jpg")
     .backgroundImageUrl("//unpkg.com/three-globe/example/img/night-sky.png")
     .atmosphereColor("#1a8cff").atmosphereAltitude(0.15)

     .pointsData([])
     .pointLat("lat")
     .pointLng("lng")
     .pointColor(d =>
       d.hop === selectedHopRef.current?.hop ? "#1d0aaa" : "#3b82f6"
     )
     .pointAltitude(0.01)
     .pointRadius(d =>
       d.hop === selectedHopRef.current?.hop ? 0.65 : 0.4
     )
     .onPointClick(point => onPointClick?.(point))
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

    g.width(containerRef.current.clientWidth);
    g.height(containerRef.current.clientHeight);
    g.pointOfView({ lat: 30, lng: 50, altitude: 2 }, 0);
    globeRef.current = g;

    const onResize = () => {
      g.width(containerRef.current.clientWidth);
      g.height(containerRef.current.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [globeRef, selectedHopRef, onPointClick]);

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
  }, [globeRef]);

  const showProgress = sendProgress !== null || receiveProgress !== null;

  return (
    <div className="globe-section">
      <div ref={containerRef} className="globe-canvas" />

      {!cablesLoaded && (
        <div className="cable-loading">
          <span className="cable-loading-dot" />
          Loading submarine cables…
        </div>
      )}

      <button
        className="globe-info-btn"
        onClick={() => setShowCableInfo(v => !v)}
        title="About submarine cable overlay"
      >
        ℹ
      </button>

      {showCableInfo && (
        <div className="globe-info-popover">
          <button
            className="globe-info-popover-close"
            onClick={() => setShowCableInfo(false)}
          >
            ✕
          </button>
          <p>
            Exact cable cannot be determined using traceroute. Submarine cable
            overlay is shown for geographic context.
          </p>
        </div>
      )}

      {showProgress && (
        <div className="transfer-panel">
          {sendProgress !== null && (
            <ProgressBar label="Sending" value={sendProgress} />
          )}
          {receiveProgress !== null && (
            <ProgressBar label="Receiving" value={receiveProgress} />
          )}
        </div>
      )}
    </div>
  );
}
