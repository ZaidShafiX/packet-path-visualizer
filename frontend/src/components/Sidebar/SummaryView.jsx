/**
 * components/Sidebar/SummaryView.jsx
 * =====================================
 * Post-trace summary panel: KPI grid, latency, network coverage, and
 * the inferred international exit point.
 *
 * Props
 * -----
 * summary  {object|null}  – output of generateSummary()
 * onBack   {Function}     – navigate back to trace view
 */

import { getRttClass, parseCityCountry } from "../../utils/summary";

export default function SummaryView({ summary, onBack }) {
  return (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={onBack}>← Hop Log</button>
        <span className="view-header-title">Trace Summary</span>
      </div>

      {summary && (
        <div className="summary-view">
          {/* Hops */}
          <div className="summary-section">
            <div className="summary-section-title">Hops</div>
            <div className="summary-kpi-grid">
              <div className="summary-kpi">
                <span className="summary-kpi-val">{summary.totalHops}</span>
                <span className="summary-kpi-label">Total</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--ok">
                  {summary.publicHops}
                </span>
                <span className="summary-kpi-label">Public</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--int">
                  {summary.privateHops}
                </span>
                <span className="summary-kpi-label">Private</span>
              </div>
              <div className="summary-kpi">
                <span className="summary-kpi-val summary-kpi-val--warn">
                  {summary.timeoutHops}
                </span>
                <span className="summary-kpi-label">Timeouts</span>
              </div>
            </div>
          </div>

          {/* Latency */}
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

          {/* Network coverage */}
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
                  {summary.distanceKm
                    ? `${summary.distanceKm.toLocaleString()}`
                    : "—"}
                </span>
                <span className="summary-kpi-label">km (geo)</span>
              </div>
            </div>
          </div>

          {/* Exit point */}
          <div className="summary-section">
            <div className="summary-section-title">International Exit Point</div>
            <div className="summary-exit-card">
              {summary.exitPoint ? (
                <>
                  <span className="summary-exit-city">
                    {parseCityCountry(summary.exitPoint.city).city ||
                      summary.exitPoint.city}
                  </span>
                  <span className="summary-exit-ip">
                    {summary.exitPoint.ip || "—"}
                  </span>
                </>
              ) : (
                <span className="summary-exit-unknown">
                  Unknown — trace may not have left origin country
                </span>
              )}
            </div>
          </div>

          <div className="summary-disclaimer">
            🌊 Exact cable route cannot be determined via traceroute. Submarine
            cable overlay is shown for geographic context only.
          </div>
        </div>
      )}
    </div>
  );
}
