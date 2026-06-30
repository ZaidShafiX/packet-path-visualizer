/**
 * hooks/useTraceroute.js
 * ======================
 * Encapsulates the traceroute WebSocket connection, hop state, and globe
 * update callbacks, extracted from App.jsx for separation of concerns.
 *
 * Returned API
 * ------------
 * hops          {Array}    – accumulated hop objects
 * traceStatus   {string}   – human-readable status line shown in the UI
 * tracing       {boolean}  – true while a traceroute is in flight
 * summary       {object|null} – generated after a complete trace
 * runTrace      {Function} – runTrace(wsUrl, label?) — open a WS and stream
 * clearTrace    {Function} – reset all state and globe layers
 * selectHop     {Function} – selectHop(hop) — toggle selection, fly globe
 * selectedHop   {object|null}
 *
 * Globe integration
 * -----------------
 * The hook needs read/write access to the globe instance and its point/arc
 * arrays.  Pass them as refs so the hook never triggers re-renders via
 * globe updates.
 *
 * @param {object} opts
 * @param {React.RefObject} opts.globeRef       – globe.gl instance ref
 * @param {React.RefObject} opts.pointsRef      – accumulated point objects
 * @param {React.RefObject} opts.arcsRef        – accumulated arc objects
 * @param {Function}        [opts.onHop]        – called for each hop (relay)
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { generateSummary } from "../utils/summary";

const DEFAULT_STATUS = "Select a destination and start a trace";

export function useTraceroute({ globeRef, pointsRef, arcsRef, onHop } = {}) {
  const [hops, setHops]               = useState([]);
  const [traceStatus, setTraceStatus] = useState(DEFAULT_STATUS);
  const [tracing, setTracing]         = useState(false);
  const [selectedHop, setSelectedHop] = useState(null);
  const [summary, setSummary]         = useState(null);

  const tracingRef     = useRef(false);
  const selectedHopRef = useRef(null);

  // ── Clear all trace state and globe layers ──────────────────────────────
  const clearTrace = useCallback(() => {
    setHops([]);
    setSelectedHop(null);
    setSummary(null);
    if (pointsRef) pointsRef.current = [];
    if (arcsRef)   arcsRef.current   = [];
    globeRef?.current?.pointsData([]);
    globeRef?.current?.arcsData([]);
    setTraceStatus(DEFAULT_STATUS);
  }, [globeRef, pointsRef, arcsRef]);

  // ── Select / deselect a hop and fly the globe ───────────────────────────
  const selectHop = useCallback((hop) => {
    setSelectedHop(prev => (prev?.hop === hop.hop ? null : hop));
  }, []);

  // Side effects (ref sync, globe point refresh, camera fly-to) run here,
  // outside the setState updater, exactly once per selection change.
  useEffect(() => {
    selectedHopRef.current = selectedHop;
    if (globeRef?.current && pointsRef?.current?.length > 0) {
      globeRef.current.pointsData([...pointsRef.current]);
    }
    if (selectedHop && selectedHop.lat && selectedHop.lng) {
      globeRef?.current?.pointOfView(
        { lat: selectedHop.lat, lng: selectedHop.lng, altitude: 1.5 }, 800
      );
    }
  }, [selectedHop, globeRef, pointsRef]);

  // ── Add a single hop to the globe (shared by runTrace + relay) ─────────
  const applyHopToGlobe = useCallback((data, collected) => {
    if (!data.timeout && !data.is_private && data.lat && data.lng) {
      if (pointsRef) pointsRef.current = [...pointsRef.current, data];
      globeRef?.current?.pointsData(pointsRef?.current ?? []);

      const prev = collected
        .slice(0, -1)
        .reverse()
        .find(h => !h.timeout && !h.is_private && h.lat);

      if (prev) {
        const arc = {
          startLat: prev.lat, startLng: prev.lng,
          endLat: data.lat,   endLng: data.lng,
        };
        if (arcsRef) arcsRef.current = [...arcsRef.current, arc];
        globeRef?.current?.arcsData(arcsRef?.current ?? []);
      }

      globeRef?.current?.pointOfView(
        { lat: data.lat, lng: data.lng, altitude: 2 }, 1000
      );
    }
  }, [globeRef, pointsRef, arcsRef]);

  // ── Open a WS and stream hops ───────────────────────────────────────────
  const runTrace = useCallback((wsUrl, label) => {
    tracingRef.current = true;
    setTracing(true);
    setHops([]);
    setSelectedHop(null);
    setSummary(null);
    setTraceStatus(label || "Tracing...");
    if (pointsRef) pointsRef.current = [];
    if (arcsRef)   arcsRef.current   = [];
    globeRef?.current?.pointsData([]);
    globeRef?.current?.arcsData([]);

    // Notify relay (e.g. DataChannel) to reset the guest's globe.
    onHop?.({ reset: true });

    const ws        = new WebSocket(wsUrl);
    const collected = [];

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);

      if (data.error) {
        setTraceStatus(`Error: ${data.error}`);
        setTracing(false);
        tracingRef.current = false;
        return;
      }

      if (data.done) {
        const located = collected.filter(h => !h.timeout && !h.is_private).length;
        setTraceStatus(`Trace complete — ${collected.length} hops, ${located} located`);
        setSummary(generateSummary(collected));
        setTracing(false);
        tracingRef.current = false;
        onHop?.({ done: true, total: collected.length, located });
        ws.close();
        return;
      }

      collected.push(data);
      setHops([...collected]);
      onHop?.(data);
      applyHopToGlobe(data, collected);
    };

    ws.onerror = () => {
      setTraceStatus("Error: backend not running");
      setTracing(false);
      tracingRef.current = false;
    };
  }, [applyHopToGlobe, onHop, globeRef, pointsRef, arcsRef]);

  return {
    hops,
    traceStatus,
    tracing,
    selectedHop,
    selectedHopRef,
    summary,
    runTrace,
    clearTrace,
    selectHop,
    DEFAULT_STATUS,
  };
}
