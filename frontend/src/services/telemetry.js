/**
 * services/telemetry.js
 * =====================
 * Lightweight telemetry bridge between the frontend and the backend logger.
 *
 * The backend never sees actual file bytes (WebRTC P2P, by design).
 * This helper reports file events back over the existing /signal WebSocket
 * so the Python logger can record them without opening a second connection.
 *
 * Wire format
 * -----------
 * { type: "telemetry", event: <eventName>, ...metadata }
 *
 * The backend's `_handle_signal_message` intercepts these, logs them at
 * INFO level, and returns True so they are NOT relayed to the remote peer.
 *
 * Usage
 * -----
 *   import { makeSendTelemetry } from "../services/telemetry";
 *
 *   // Inside a hook, after the signalRef is set up:
 *   const sendTelemetry = makeSendTelemetry(signalRef);
 *   sendTelemetry("file_shared", { filename: "cat.png", size: 204800, room: "ABC123" });
 */

/**
 * Factory that returns a `sendTelemetry` function bound to *signalRef*.
 *
 * @param {React.MutableRefObject<WebSocket|null>} signalRef
 *   Ref pointing at the live /signal WebSocket (may be null when idle).
 * @returns {(eventName: string, metadata?: object) => void}
 */
export function makeSendTelemetry(signalRef) {
  /**
   * Send a telemetry event over the signaling WebSocket.
   *
   * @param {string} eventName   – e.g. "file_shared", "file_downloaded"
   * @param {object} [metadata]  – arbitrary key/value pairs to log
   */
  return function sendTelemetry(eventName, metadata = {}) {
    const ws = signalRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "telemetry", event: eventName, ...metadata }));
    }
  };
}
