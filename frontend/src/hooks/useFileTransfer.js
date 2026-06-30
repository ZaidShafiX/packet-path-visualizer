/**
 * hooks/useFileTransfer.js
 * =========================
 * WebRTC peer-to-peer file transfer hook.
 *
 * Manages:
 * - WebSocket signaling connection (/signal endpoint)
 * - RTCPeerConnection + RTCDataChannel lifecycle
 * - Chunked file send with backpressure control
 * - Chunked file receive with progress tracking
 * - Peer IP discovery via getStats()
 * - Telemetry bridge to the backend logger
 * - Trace-hop relay over the data channel (so both peers see the globe animate)
 *
 * Returned API
 * ------------
 * role, roomCode, connState, statusText
 * sendProgress, receiveProgress, incomingFile, peerIp
 * hostTransfer()    – create a room as host
 * joinTransfer(code) – join an existing room as guest
 * sendFile(file)    – send a File object over the data channel
 * reset()           – tear down everything and return to idle
 * relayTraceHop(data) – forward a hop object to the remote peer
 * sendTelemetry(event, meta) – fire a backend log event
 */

import { useRef, useState, useCallback } from "react";
import { SIGNAL_URL, RTC_CONFIG }  from "../services/signaling";
import { makeSendTelemetry }        from "../services/telemetry";

const CHUNK_SIZE   = 16 * 1024;        // 16 KB per DataChannel message
const BUFFER_LIMIT =  1 * 1024 * 1024; // pause sending above 1 MB buffered

export function useFileTransfer({ onPeerIpDiscovered, onTraceHop } = {}) {
  const [role, setRole]                       = useState(null);
  const [roomCode, setRoomCode]               = useState("");
  const [connState, setConnState]             = useState("idle");
  const [statusText, setStatusText]           = useState("");
  const [sendProgress, setSendProgress]       = useState(null);
  const [receiveProgress, setReceiveProgress] = useState(null);
  const [incomingFile, setIncomingFile]       = useState(null);
  const [peerIp, setPeerIp]                   = useState(null);

  const signalRef       = useRef(null);
  const pcRef           = useRef(null);
  const dcRef           = useRef(null);
  const ipDiscoveredRef = useRef(false);
  const recvMetaRef     = useRef(null);
  const recvBufRef      = useRef([]);
  const recvSizeRef     = useRef(0);
  const onTraceHopRef   = useRef(onTraceHop);
  onTraceHopRef.current = onTraceHop;

  // Mirrors roomCode state into a ref so stable useCallbacks always see the
  // current value instead of a stale closure value.
  const roomCodeRef   = useRef(roomCode);
  roomCodeRef.current = roomCode;

  // ── Telemetry bridge ──────────────────────────────────────────────────────
  // Built from the factory in services/telemetry.js, bound to signalRef.
  const sendTelemetry = useCallback(
    makeSendTelemetry(signalRef),
    // makeSendTelemetry returns a stable function; signalRef is a ref object
    // (stable identity), so this effect dependency array is intentionally empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Peer IP discovery via getStats() ──────────────────────────────────────
  const discoverPeerIp = useCallback(async (pc) => {
    if (ipDiscoveredRef.current) return;
    await new Promise(r => setTimeout(r, 500)); // let stats settle
    try {
      const stats             = await pc.getStats();
      const remoteCandidates  = {};
      const succeededPairs    = [];

      stats.forEach(r => {
        if (r.type === "remote-candidate") remoteCandidates[r.id] = r;
        if (r.type === "candidate-pair" && r.state === "succeeded")
          succeededPairs.push(r);
      });

      for (const pair of succeededPairs) {
        const remote = remoteCandidates[pair.remoteCandidateId];
        if (remote?.ip) {
          ipDiscoveredRef.current = true;
          setPeerIp(remote.ip);
          onPeerIpDiscovered?.(remote.ip, remote.candidateType);
          return;
        }
      }
    } catch (e) {
      console.error("getStats failed", e);
    }
  }, [onPeerIpDiscovered]);

  // ── Wire a DataChannel ────────────────────────────────────────────────────
  const wireDataChannel = useCallback((dc) => {
    dc.binaryType = "arraybuffer";
    dcRef.current = dc;

    dc.onopen = () => {
      setConnState("connected");
      setStatusText("Connected — pick a file to send, or wait to receive one");
    };

    dc.onclose = () => {
      setConnState("closed");
      setStatusText("Connection closed");
    };

    dc.onmessage = (event) => {
      // ── Control messages (JSON strings) ──────────────────────────────────
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);

        if (msg.type === "trace-hop") {
          onTraceHopRef.current?.(msg.payload);
          return;
        }

        if (msg.type === "file-start") {
          recvMetaRef.current = {
            name: msg.name,
            size: msg.size,
            mime: msg.mime || "application/octet-stream",
          };
          recvBufRef.current  = [];
          recvSizeRef.current = 0;
          setReceiveProgress(0);
          setStatusText(`Receiving "${msg.name}"...`);
        }

        if (msg.type === "file-end") {
          const meta = recvMetaRef.current;
          if (meta) {
            const blob = new Blob(recvBufRef.current, { type: meta.mime });
            setIncomingFile({
              name: meta.name,
              size: meta.size,
              url: URL.createObjectURL(blob),
            });
            setStatusText(`✅ Received "${meta.name}"`);

            // Telemetry: notify backend that a P2P download completed.
            // Fired after blob assembly so the log reflects a *completed*
            // transfer rather than an initiated one.
            sendTelemetry("file_downloaded", {
              filename: meta.name,
              size:     meta.size,
              room:     roomCodeRef.current,
            });
          }
          setReceiveProgress(null);
          recvMetaRef.current = null;
          recvBufRef.current  = [];
        }
        return;
      }

      // ── Binary chunks ─────────────────────────────────────────────────────
      recvBufRef.current.push(event.data);
      recvSizeRef.current += event.data.byteLength;
      const meta = recvMetaRef.current;
      if (meta?.size) {
        setReceiveProgress(
          Math.min(100, Math.round((recvSizeRef.current / meta.size) * 100))
        );
      }
    };
  }, [sendTelemetry]);

  // ── Create RTCPeerConnection ───────────────────────────────────────────────
  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate && signalRef.current?.readyState === WebSocket.OPEN) {
        signalRef.current.send(
          JSON.stringify({ type: "ice", candidate: e.candidate })
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") discoverPeerIp(pc);
      if (s === "failed" || s === "disconnected") {
        setConnState("failed");
        setStatusText("Connection failed — peer may need a TURN server");
      }
    };

    pc.ondatachannel = (e) => wireDataChannel(e.channel);

    return pc;
  }, [discoverPeerIp, wireDataChannel]);

  // ── Open signaling WebSocket ──────────────────────────────────────────────
  const connectSignal = useCallback((newRole, code) => {
    const url = newRole === "host"
      ? `${SIGNAL_URL}?role=host`
      : `${SIGNAL_URL}?role=guest&room=${code}`;

    const ws = new WebSocket(url);
    signalRef.current = ws;

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "room_created":
          setRoomCode(msg.room);
          setStatusText(`Share this code with your friend: ${msg.room}`);
          break;

        case "guest_joined": {
          setStatusText("Friend joined — connecting...");
          setConnState("connecting");
          const pc = createPeerConnection();
          const dc = pc.createDataChannel("file");
          wireDataChannel(dc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: "offer", sdp: offer }));
          break;
        }

        case "joined":
          setStatusText("Joined — waiting for host...");
          setConnState("connecting");
          createPeerConnection();
          break;

        case "offer": {
          const pc = pcRef.current;
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", sdp: answer }));
          break;
        }

        case "answer":
          await pcRef.current?.setRemoteDescription(
            new RTCSessionDescription(msg.sdp)
          );
          break;

        case "ice":
          if (pcRef.current && msg.candidate) {
            try {
              await pcRef.current.addIceCandidate(
                new RTCIceCandidate(msg.candidate)
              );
            } catch (e) {
              console.error("addIceCandidate failed", e);
            }
          }
          break;

        case "peer_disconnected":
          setConnState("closed");
          setStatusText("Your friend disconnected");
          break;

        case "error":
          setConnState("failed");
          setStatusText(msg.message || "Signaling error");
          break;
      }
    };

    ws.onerror = () => {
      setConnState("failed");
      setStatusText("Cannot reach backend — is it running?");
    };
  }, [createPeerConnection, wireDataChannel]);

  // ── Public actions ────────────────────────────────────────────────────────

  const hostTransfer = useCallback(() => {
    setRole("host");
    setConnState("waiting");
    setStatusText("Creating room...");
    connectSignal("host");
  }, [connectSignal]);

  const joinTransfer = useCallback((code) => {
    setRole("guest");
    setConnState("connecting");
    setStatusText("Joining room...");
    connectSignal("guest", code.trim().toUpperCase());
  }, [connectSignal]);

  const sendFile = useCallback((file) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") {
      setStatusText("Not connected yet");
      return;
    }

    // Telemetry: notify backend a P2P send is starting.
    sendTelemetry("file_shared", {
      filename: file.name,
      size:     file.size,
      room:     roomCodeRef.current,
    });

    setSendProgress(0);
    setStatusText(`Sending "${file.name}"...`);
    dc.send(
      JSON.stringify({ type: "file-start", name: file.name, size: file.size, mime: file.type })
    );

    let offset = 0;
    dc.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;

    const sendNext = () => {
      if (dc.readyState !== "open") return;

      if (dc.bufferedAmount > BUFFER_LIMIT) {
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; sendNext(); };
        return;
      }

      const slice  = file.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();
      reader.onload = () => {
        dc.send(reader.result);
        offset += slice.size;
        setSendProgress(
          Math.min(100, Math.round((offset / file.size) * 100))
        );

        if (offset < file.size) {
          sendNext();
        } else {
          dc.send(JSON.stringify({ type: "file-end" }));
          setStatusText(`✅ Sent "${file.name}"`);
          setSendProgress(null);
        }
      };
      reader.readAsArrayBuffer(slice);
    };

    sendNext();
  }, [sendTelemetry]);

  const relayTraceHop = useCallback((data) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ type: "trace-hop", payload: data }));
    }
  }, []);

  const reset = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    signalRef.current?.close();
    dcRef.current = signalRef.current = pcRef.current = null;
    ipDiscoveredRef.current = false;
    setRole(null);
    setRoomCode("");
    setConnState("idle");
    setStatusText("");
    setSendProgress(null);
    setReceiveProgress(null);
    setIncomingFile(null);
    setPeerIp(null);
  }, []);

  return {
    role, roomCode, connState, statusText,
    sendProgress, receiveProgress, incomingFile, peerIp,
    hostTransfer, joinTransfer, sendFile, reset,
    relayTraceHop,
    sendTelemetry,
  };
}
