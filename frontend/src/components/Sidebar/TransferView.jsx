/**
 * components/Sidebar/TransferView.jsx
 * =====================================
 * P2P file transfer controls: host/join, room code display, connected state,
 * send button, incoming file card, and a relayed hop log for the guest.
 *
 * Props
 * -----
 * transfer       {object}   – full return value of useFileTransfer
 * hops           {Array}    – relayed hops (guest view)
 * selectedHop    {object|null}
 * onSelectHop    {Function}
 * onBack         {Function}
 * fileInputRef   {React.RefObject}
 * onPickFile     {Function}  – file input onChange handler
 */

import { useState } from "react";
import { formatBytes, groupHopsByASN, getRttClass } from "../../utils/summary";
import ProgressBar from "../shared/ProgressBar";

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

export default function TransferView({
  transfer,
  hops,
  selectedHop,
  onSelectHop,
  onBack,
  fileInputRef,
  onPickFile,
  summary,
  onSummary,
}) {
  const [joinCode, setJoinCode] = useState("");

  return (
    <div className="view-content">
      <div className="view-header">
        <button className="btn-back" onClick={onBack}>← Back</button>
        <span className="view-header-title">P2P File Transfer</span>
      </div>

      <div className="control-section">
        {/* ── Idle: host or join ── */}
        {transfer.role === null && (
          <>
            <label className="field-label">Start a session or join one</label>
            <button
              className="btn-primary btn-primary--wide"
              onClick={transfer.hostTransfer}
            >
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

        {/* ── Waiting for guest ── */}
        {transfer.role === "host" &&
          transfer.connState === "waiting" &&
          transfer.roomCode && (
            <div className="room-code-display">
              <label className="field-label">Share this code with your friend</label>
              <div className="room-code-box">
                <span className="room-code-value">{transfer.roomCode}</span>
              </div>
              <p className="room-code-hint">Waiting for peer to connect…</p>
              <button
                className="btn-ghost-sm"
                style={{ marginTop: "8px" }}
                onClick={transfer.reset}
              >
                Cancel
              </button>
            </div>
          )}

        {/* ── Connected ── */}
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
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={onPickFile}
                />
                <button
                  className="btn-primary btn-primary--wide"
                  onClick={() => fileInputRef.current.click()}
                >
                  📤  Choose File to Send
                </button>
              </>
            )}

            <button className="btn-ghost-sm" onClick={transfer.reset}>
              Disconnect
            </button>
          </div>
        )}

        {/* ── Incoming file download card ── */}
        {transfer.incomingFile && (
          <div className="download-card">
            <span className="download-icon">⬇</span>
            <div className="download-info">
              <span className="download-name">{transfer.incomingFile.name}</span>
              <span className="download-size">
                {formatBytes(transfer.incomingFile.size)}
              </span>
            </div>
            <a
              className="btn-primary"
              href={transfer.incomingFile.url}
              download={transfer.incomingFile.name}
            >
              Save
            </a>
          </div>
        )}

        {/* ── Reset button when not idle/waiting/connected ── */}
        {transfer.role &&
          transfer.connState !== "connected" &&
          transfer.connState !== "waiting" && (
            <button className="btn-ghost-sm" onClick={transfer.reset}>
              ← Reset
            </button>
          )}

        <div className={`status-chip ${transfer.statusText ? "status-chip--active" : ""}`}>
          {transfer.statusText || "Idle"}
        </div>
      </div>

      {/* Transfer progress bars */}
      {(transfer.sendProgress !== null || transfer.receiveProgress !== null) && (
        <div className="progress-section">
          {transfer.sendProgress !== null && (
            <ProgressBar label="Sending" value={transfer.sendProgress} />
          )}
          {transfer.receiveProgress !== null && (
            <ProgressBar label="Receiving" value={transfer.receiveProgress} />
          )}
        </div>
      )}

      {/* Summary CTA */}
      {summary && (
        <div className="summary-cta">
          <button className="btn-summary-cta" onClick={onSummary}>
            <span>📊</span>
            View Trace Summary
            <span className="summary-cta-arrow">→</span>
          </button>
        </div>
      )}

      {/* Relayed hop log for guest */}
      {hops.length > 0 && (
        <>
          <div
            className="hop-log-header"
            style={{ padding: "0 22px", marginTop: "8px" }}
          >
            <span className="hop-log-title">Route from Host</span>
            <span className="hop-count-badge">{hops.length} hops</span>
          </div>
          <div className="hop-log">
            {groupHopsByASN(hops).map((group, gIdx) => {
              const isAsnGroup = group.asn != null && group.hops.length >= 2;
              if (!isAsnGroup) {
                return group.hops.map(h => (
                  <HopCard
                    key={h.hop}
                    h={h}
                    selectedHop={selectedHop}
                    onSelectHop={onSelectHop}
                  />
                ));
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
                  {group.hops.map(h => (
                    <HopCard
                      key={h.hop}
                      h={h}
                      selectedHop={selectedHop}
                      onSelectHop={onSelectHop}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
