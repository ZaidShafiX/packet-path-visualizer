/**
 * components/shared/ProgressBar.jsx
 * ===================================
 * Reusable labelled progress bar used for both send and receive progress.
 *
 * Props
 * -----
 * label    {string}  – text shown to the left (e.g. "Sending", "Receiving")
 * value    {number}  – 0–100 percentage
 */

export default function ProgressBar({ label, value }) {
  return (
    <div className="progress-row">
      <span className="progress-label">{label}</span>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${value}%` }} />
      </div>
      <span className="progress-pct">{value}%</span>
    </div>
  );
}
