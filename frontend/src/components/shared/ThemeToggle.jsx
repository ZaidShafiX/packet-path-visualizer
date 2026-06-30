/**
 * components/shared/ThemeToggle.jsx
 * ==================================
 * Dark / light theme toggle pill.
 *
 * Props
 * -----
 * theme    {string}   – "dark" | "light"
 * onTheme  {Function} – called with the new theme string on click
 */

export default function ThemeToggle({ theme, onTheme }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        className={`theme-btn ${theme === "dark" ? "theme-btn--active" : ""}`}
        onClick={() => onTheme("dark")}
        title="Dark mode"
        aria-pressed={theme === "dark"}
      >
        🌙
      </button>
      <button
        className={`theme-btn ${theme === "light" ? "theme-btn--active" : ""}`}
        onClick={() => onTheme("light")}
        title="Light mode"
        aria-pressed={theme === "light"}
      >
        ☀️
      </button>
    </div>
  );
}
