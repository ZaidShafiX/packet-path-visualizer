/**
 * components/Sidebar/HomeView.jsx
 * ================================
 * Landing / home panel shown when no mode has been selected yet.
 *
 * Props
 * -----
 * onTrace    {Function} – navigate to trace view
 * onTransfer {Function} – navigate to transfer view
 */

export default function HomeView({ onTrace, onTransfer }) {
  return (
    <div className="view-home">
      <div className="home-hero">
        <div className="home-logo">
          <span className="home-logo-icon">⊶</span>
        </div>
        <h1 className="home-title">Packet Path Visualizer</h1>
        <p className="home-subtitle">
          Visualize your internet route in real time — see every hop, latency,
          and submarine cable between you and the destination.
        </p>
      </div>

      <div className="home-actions">
        <button className="home-card" onClick={onTrace}>
          <div className="home-card-icon-wrap home-card-icon--trace">
            <span className="home-card-icon">🛰️</span>
          </div>
          <div className="home-card-body">
            <span className="home-card-title">Trace Server Routes</span>
            <span className="home-card-desc">
              Map the network path to major internet destinations worldwide
            </span>
          </div>
          <span className="home-card-arrow">→</span>
        </button>

        <button className="home-card" onClick={onTransfer}>
          <div className="home-card-icon-wrap home-card-icon--transfer">
            <span className="home-card-icon">📡</span>
          </div>
          <div className="home-card-body">
            <span className="home-card-title">Send File to Friend</span>
            <span className="home-card-desc">
              Transfer files peer-to-peer and trace the route between you
            </span>
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
}
