/**
 * WebRTC Peer — client-side DataChannel negotiation.
 *
 * Creates an RTCPeerConnection, negotiates via WebSocket signaling messages,
 * and hands the established DataChannel to the transport layer for atomic
 * upgrade from WebSocket to P2P.
 *
 * Design decisions:
 * - Raw RTCPeerConnection (no SimplePeer — caused SDP mutation crashes)
 * - Client initiates DataChannel (createDataChannel)
 * - Single attempt per connection — no retry loop (transport falls back to WS)
 * - Optional: if RTCPeerConnection is not available, silently no-ops
 */

/**
 * Create a WebRTC peer that negotiates a DataChannel via WS signaling.
 *
 * @param {object} opts
 * @param {(msg: object) => void} opts.sendSignaling — send signaling message via WebSocket
 * @param {(dc: RTCDataChannel) => void} opts.onDataChannel — called when DC is open and ready
 * @param {(type: string) => void} [opts.onStateChange] — called with 'connecting', 'connected', 'failed', 'closed'
 * @returns {object} Peer API
 */
const ICE_TIMEOUT_MS = 15_000; // 15s — if DC isn't open by then, ICE can't connect

export function createWebRTCPeer({ sendSignaling, onDataChannel, onStateChange }) {
  let pc = null;
  let dc = null;
  let iceTimer = null;
  let state = "idle"; // idle | connecting | connected | failed | closed

  function setState(s) {
    state = s;
    if (onStateChange) onStateChange(s);
  }

  /**
   * Initiate WebRTC negotiation.
   * Creates PeerConnection + DataChannel, generates offer, sends via signaling.
   */
  async function connect() {
    if (typeof RTCPeerConnection === "undefined") return;
    if (pc) close(); // Clean up previous attempt

    try {
      setState("connecting");

      // No STUN servers — LAN-only host candidates to avoid leaking real
      // IP to external STUN servers. Through tunnels, WebRTC won't connect
      // and we fall back to WebSocket gracefully. See dfa68b1.
      pc = new RTCPeerConnection();

      dc = pc.createDataChannel("katulong", { ordered: true });

      dc.onopen = () => {
        if (iceTimer) { clearTimeout(iceTimer); iceTimer = null; }
        setState("connected");
        onDataChannel(dc);
      };

      dc.onclose = () => {
        if (state === "connected") setState("closed");
      };

      dc.onerror = () => {
        if (state === "connecting") setState("failed");
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignaling({ type: "rtc-ice-candidate", candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          setState("failed");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignaling({ type: "rtc-offer", sdp: offer.sdp });

      // Timeout: if DC doesn't open in time, ICE can't connect
      iceTimer = setTimeout(() => {
        iceTimer = null;
        if (state === "connecting") setState("failed");
      }, ICE_TIMEOUT_MS);
    } catch {
      setState("failed");
    }
  }

  /**
   * Handle rtc-answer from server.
   */
  async function handleAnswer(sdp) {
    if (!pc) return;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch {
      setState("failed");
    }
  }

  /**
   * Handle rtc-ice-candidate from server.
   */
  function handleCandidate(candidate) {
    if (!pc) return;
    try {
      pc.addIceCandidate(candidate);
    } catch {
      // Ignore ICE errors — connection may still succeed
    }
  }

  /**
   * Close the peer connection and DataChannel.
   */
  function close() {
    if (iceTimer) { clearTimeout(iceTimer); iceTimer = null; }
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    setState("closed");
  }

  return {
    connect,
    handleAnswer,
    handleCandidate,
    close,
    get state() { return state; },
  };
}
