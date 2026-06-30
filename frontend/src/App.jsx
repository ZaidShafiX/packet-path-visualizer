import { useEffect, useRef, useState, useCallback } from "react";
import { useFileTransfer }  from "./hooks/useFileTransfer";
import { useTraceroute }    from "./hooks/useTraceroute";
import Globe                from "./components/Globe/Globe";
import Sidebar              from "./components/Sidebar/Sidebar";
import HomeView             from "./components/Sidebar/HomeView";
import TraceView            from "./components/Sidebar/TraceView";
import TransferView         from "./components/Sidebar/TransferView";
import SummaryView          from "./components/Sidebar/SummaryView";
import { generateSummary }  from "./utils/summary";
import "./App.css";

const BACKEND_WS = window.location.hostname === "localhost"
  ? "ws://localhost:8000"
  : `wss://${window.location.host}`;

export default function App() {
  const globeRef       = useRef(null);
  const pointsRef      = useRef([]);
  const arcsRef        = useRef([]);
  const relayHopRef    = useRef(null);
  const roleRef        = useRef(null);
  const relayedHopsRef = useRef([]);
  const fileInputRef   = useRef(null);

  const [view, setView]             = useState("home");
  const [theme, setTheme]           = useState("dark");
  const [target, setTarget]         = useState("google");
  const [relayedHops, setRelayedHops] = useState([]);
  const [relayedSummary, setRelayedSummary] = useState(null);

  // ── Apply theme to <html> ─────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ── Relay handler: guest receives host's hops over DataChannel ────────────
  const handleRelayedHop = useCallback((data) => {
    if (data.reset) {
      relayedHopsRef.current = [];
      setRelayedHops([]);
      setRelayedSummary(null);
      pointsRef.current = [];
      arcsRef.current   = [];
      globeRef.current?.pointsData([]);
      globeRef.current?.arcsData([]);
      setView("trace");
      return;
    }
    if (data.done) {
      setRelayedSummary(generateSummary(relayedHopsRef.current));
      return;
    }
    relayedHopsRef.current = [...relayedHopsRef.current, data];
    setRelayedHops([...relayedHopsRef.current]);
    // Globe update for guest
    if (!data.timeout && !data.is_private && data.lat && data.lng) {
      pointsRef.current = [...pointsRef.current, data];
      globeRef.current?.pointsData(pointsRef.current);
      const prev = relayedHopsRef.current
        .slice(0, -1).reverse()
        .find(h => !h.timeout && !h.is_private && h.lat);
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

  // ── Traceroute hook ───────────────────────────────────────────────────────
  const traceroute = useTraceroute({
    globeRef,
    pointsRef,
    arcsRef,
    onHop: (data) => relayHopRef.current?.(data),
  });

  // ── Start trace to peer IP (V2) ───────────────────────────────────────────
  const startTraceToIP = useCallback((ip) => {
    if (roleRef.current === "guest") {
      setView("trace");
      return;
    }
    traceroute.runTrace(`${BACKEND_WS}/trace-ip?ip=${ip}`, `Tracing path to peer (${ip})...`);
    setView("trace");
  }, [traceroute]);

  // ── File transfer hook ────────────────────────────────────────────────────
  const transfer = useFileTransfer({
    onPeerIpDiscovered: startTraceToIP,
    onTraceHop: handleRelayedHop,
  });

  relayHopRef.current = transfer.relayTraceHop;
  roleRef.current     = transfer.role;

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (!traceroute.hops.length) return;
      e.preventDefault();
      const hops = traceroute.hops;
      const currentIdx = traceroute.selectedHop
        ? hops.findIndex(h => h.hop === traceroute.selectedHop.hop)
        : -1;
      const nextIdx = e.key === "ArrowDown"
        ? (currentIdx < hops.length - 1 ? currentIdx + 1 : 0)
        : (currentIdx > 0 ? currentIdx - 1 : hops.length - 1);
      const next = hops[nextIdx];
      if (next) traceroute.selectHop(next);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [traceroute]);

  const handlePickFile = (e) => {
    const file = e.target.files[0];
    if (file) transfer.sendFile(file);
    e.target.value = "";
  };

  const startTrace = () => {
    traceroute.runTrace(`${BACKEND_WS}/trace?target=${target}`);
    setView("trace");
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-container">
      <Globe
        globeRef={globeRef}
        pointsRef={pointsRef}
        arcsRef={arcsRef}
        selectedHopRef={traceroute.selectedHopRef}
        onPointClick={traceroute.selectHop}
        sendProgress={transfer.sendProgress}
        receiveProgress={transfer.receiveProgress}
      />

      <Sidebar theme={theme} onTheme={setTheme}>
        {view === "home" && (
          <HomeView
            onTrace={() => setView("trace")}
            onTransfer={() => setView("transfer")}
          />
        )}

        {view === "trace" && (
          <TraceView
            hops={traceroute.hops}
            tracing={traceroute.tracing}
            traceStatus={traceroute.traceStatus}
            target={target}
            onTarget={setTarget}
            onStart={startTrace}
            onClear={traceroute.clearTrace}
            onBack={() => setView("home")}
            selectedHop={traceroute.selectedHop}
            onSelectHop={traceroute.selectHop}
            summary={traceroute.summary}
            onSummary={() => setView("summary")}
          />
        )}

        {view === "transfer" && (
          <TransferView
            transfer={transfer}
            hops={relayedHops}
            selectedHop={traceroute.selectedHop}
            onSelectHop={traceroute.selectHop}
            onBack={() => setView("home")}
            fileInputRef={fileInputRef}
            onPickFile={handlePickFile}
            summary={relayedSummary}
            onSummary={() => setView("summary")}
          />
        )}

        {view === "summary" && (
          <SummaryView
            summary={traceroute.summary || relayedSummary}
            onBack={() => setView(roleRef.current === "guest" ? "transfer" : "trace")}
          />
        )}
      </Sidebar>
    </div>
  );
}
