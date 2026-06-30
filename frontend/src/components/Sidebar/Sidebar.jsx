/**
 * components/Sidebar/Sidebar.jsx
 * ================================
 * Sidebar shell: wordmark, theme toggle, and the scrollable content area.
 * The active view is passed as `children` from App.jsx.
 *
 * Props
 * -----
 * theme     {string}   – "dark" | "light"
 * onTheme   {Function} – theme change handler
 * children  {ReactNode}
 */

import ThemeToggle from "../shared/ThemeToggle";

export default function Sidebar({ theme, onTheme, children }) {
  return (
    <div className="sidebar">
      <div className="sidebar-wordmark">
        <span className="wordmark-dot" />
        Packet Path Visualizer
        <ThemeToggle theme={theme} onTheme={onTheme} />
      </div>
      <div className="sidebar-scroll">
        {children}
      </div>
    </div>
  );
}
