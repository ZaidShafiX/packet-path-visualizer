/**
 * services/signaling.js
 * =====================
 * Shared constants for the WebRTC signaling layer.
 *
 * Exports
 * -------
 * SIGNAL_URL  – WebSocket URL for the /signal endpoint, derived from
 *               the current page's host so the same code works on
 *               localhost (ws://) and behind ngrok/production (wss://).
 *
 * RTC_CONFIG  – RTCPeerConnection configuration with STUN servers and
 *               a free public TURN relay (Open Relay Project) as fallback
 *               for peers behind symmetric NAT / CGNAT where STUN-only
 *               direct connections cannot form.
 */

export const SIGNAL_URL =
  window.location.hostname === "localhost"
    ? "ws://localhost:8000/signal"
    : `wss://${window.location.host}/signal`;

export const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free public TURN relay (Open Relay Project) — fallback for peers
    // behind symmetric NAT / CGNAT.
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};
