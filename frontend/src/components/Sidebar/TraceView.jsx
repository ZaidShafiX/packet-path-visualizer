/**
 * components/Sidebar/TraceView.jsx
 * =================================
 * Traceroute controls, status chip, hop detail panel, and hop log.
 *
 * Props
 * -----
 * hops          {Array}
 * tracing       {boolean}
 * traceStatus   {string}
 * target        {string}       – selected target id
 * onTarget      {Function}     – (id) => void
 * onStart       {Function}     – start trace
 * onClear       {Function}     – clear trace + navigate home
 * onBack        {Function}     – navigate back to home
 * selectedHop   {object|null}
 * onSelectHop   {Function}     – (hop) => void
 * summary       {object|null}
 * onSummary     {Function}     – navigate to summary view
 */

import { getRttClass, hopStatusLabel, groupHopsByASN } from "../../utils/summary";

const TARGETS = [
  { id: "google",     label: "Google DNS",        sublabel: "8.8.8.8",        flag: "🌐" },
  { id: "cloudflare", label: "Cloudflare DNS",    sublabel: "1.1.1.1",        flag: "⚡" },
  { id: "london",     label: "London — BBC",      sublabel: "United Kingdom",  flag: "🇬🇧" },
  { id: "tokyo",      label: "Tokyo — AWS",        sublabel: "Japan",           flag: "🇯🇵" },
  { id: "new-york",   label: "New York — Fastly", sublabel: "United States",   flag: "🇺🇸" },
];

function HopCard({ h, selectedHop, onSelectHop }) {
  let cls = "hop-card";
  if (h.timeout)          cls += " hop-warn";
  else if (h.is_private)  cls += " hop-internal";
  else if (h.no_location) cls += " hop-nogeo";
  else                    cls += " hop-ok";
  if (selectedHop?.hop === h.hop) cls += " selected";

  return (
    <div className={cls} onClick={() => onSelectHop(h)}>
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
}

function HopGroups({ hops, selectedHop, onSelectHop }) {
  return groupHopsByASN(hops).map((group, gIdx) => {
    const isAsnGroup = group.asn != null && group.hops.length >= 2;
    if (!isAsnGroup) {
      return group.hops.map(h => (
        <HopCard key={h.hop} h={h} selectedHop={selectedHop} onSelectHop={onSelectHop} />
      ));
    }
    return (
      <div key={`asn-${gIdx}`} className="asn-group">
        <div className="asn-group-header">
          <span className="asn-group-name">{group.org || `AS${group.asn}`}</span>
          <span className="asn-group-badge">AS{group.asn} · {group.hops.length} hops</span>
        </div>
        {group.hops.map(h => (
          <HopCard key={h.hop} h={h} selectedHop={selectedHop} onSelectHop={onSelectHop} />
        ))}
      </div>
    );
  });
}

export default function TraceView({
  hops,
  tracing,
  traceStatus,
  target,
  onTarget,
  onStart,
  onClear,
  onBack,
  selectedHop,
  onSelectHop,
  summary,
  onSummary,
}) {
  return (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={onBack}>
          ← Back
        </button>
        <span className="view-header-title">Route Trace</span>
        <span className="live-badge">LIVE</span>
      </div>

      {/* Controls */}
      <div className="control-section">
        <label className="field-label">Destination</label>
        <div className="target-grid">
          {TARGETS.map(t => (
            <button
              key={t.id}
              className={`target-chip ${target === t.id ? "target-chip--active" : ""}`}
              onClick={() => onTarget(t.id)}
              disabled={tracing}
            >
              <span className="target-chip-flag">{t.flag}</span>
              <span className="target-chip-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="action-row">
          <button
            className="btn-primary btn-primary--wide"
            onClick={onStart}
            disabled={tracing}
          >
            {tracing ? (
              <>
                <span className="btn-spinner" />
                Tracing…
              </>
            ) : (
              "▶  Start Trace"
            )}
          </button>
          <button className="btn-ghost-sm" onClick={onClear} disabled={tracing}>
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
            <button className="detail-panel-close" onClick={() => onSelectHop(null)}>✕</button>
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
          <button className="btn-summary-cta" onClick={onSummary}>
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
            <HopGroups hops={hops} selectedHop={selectedHop} onSelectHop={onSelectHop} />
            <div className="hop-log-kb-hint">↑ ↓ to navigate · click to inspect</div>
          </>
        )}
      </div>
    </div>
  );
}
