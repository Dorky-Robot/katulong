/**
 * WebRTC Signaling Module
 *
 * Manages per-client RTCPeerConnection lifecycle for WebRTC DataChannel
 * transport. Handles SDP offer/answer exchange and ICE candidate trickle
 * over the existing WebSocket connection.
 *
 * Design decisions:
 *
 * 1. **No SimplePeer.** A previous implementation used SimplePeer but it
 *    mutated SDP properties that node-datachannel made read-only, causing
 *    crashes. We use raw RTCPeerConnection to keep full control.
 *
 * 2. **Single-active-transport model.** The DataChannel does not run
 *    alongside WebSocket — the transport layer will switch atomically.
 *    This module only handles signaling; transport routing lives elsewhere.
 *
 * 3. **Optional dependency on node-datachannel.** The RTCPeerConnection
 *    class can be injected (for testing) or dynamically imported from
 *    node-datachannel. If the import fails, WebRTC is simply unavailable.
 *
 * 4. **Error isolation.** WebRTC failures (bad SDP, ICE errors, missing
 *    native module) are caught and logged — they never crash the server
 *    or break the WebSocket fallback.
 */

import { log } from "./log.js";

/**
 * Create a WebRTC signaling handler.
 *
 * @param {object} opts
 * @param {(clientId: string, dc: object) => void} opts.onDataChannel
 *   Called when a DataChannel is established and ready.
 * @param {(clientId: string, msg: object) => void} opts.onSend
 *   Send a signaling message back to the client via WebSocket.
 * @param {new () => RTCPeerConnection} [opts.RTCPeerConnection]
 *   Optional injected RTCPeerConnection class (for testing or custom builds).
 *   If not provided, attempts dynamic import from node-datachannel.
 * @returns {object} Signaling API
 */
export function createWebRTCSignaling({ onDataChannel, onSend, RTCPeerConnection: InjectedPeerConnection } = {}) {
  // clientId -> RTCPeerConnection
  const peerConnections = new Map();

  /**
   * Resolve the RTCPeerConnection class to use.
   * Prefers the injected class; falls back to dynamic import of node-datachannel.
   */
  let resolvedPeerConnection = InjectedPeerConnection || null;

  async function getPeerConnectionClass() {
    if (resolvedPeerConnection) return resolvedPeerConnection;
    try {
      const mod = await import("node-datachannel/polyfill");
      resolvedPeerConnection = mod.RTCPeerConnection || mod.default?.RTCPeerConnection;
      log.debug("WebRTC: node-datachannel/polyfill loaded", { found: !!resolvedPeerConnection });
      return resolvedPeerConnection;
    } catch (err) {
      log.warn("WebRTC: node-datachannel/polyfill import failed", { error: err?.message || String(err) });
      return null;
    }
  }

  /**
   * Handle an rtc-offer message from a client.
   *
   * Creates (or replaces) an RTCPeerConnection for the client, sets the
   * remote description from the offer, creates an answer, and sends it
   * back via onSend.
   *
   * @param {string} clientId
   * @param {{ type: string, sdp: string }} offer
   */
  async function handleOffer(clientId, offer) {
    try {
      const PeerConnection = await getPeerConnectionClass();
      if (!PeerConnection) {
        log.warn("WebRTC offer ignored: RTCPeerConnection not available", { clientId });
        return;
      }

      // Close existing connection if re-offering (ICE restart)
      const existing = peerConnections.get(clientId);
      if (existing) {
        try { existing.close(); } catch {}
        peerConnections.delete(clientId);
      }

      const pc = new PeerConnection();
      peerConnections.set(clientId, pc);

      // Wire up datachannel callback
      pc.ondatachannel = (event) => {
        try {
          onDataChannel(clientId, event.channel);
        } catch (err) {
          log.error("onDataChannel callback error", { clientId, error: err?.message || String(err) });
        }
      };

      // Wire up ICE candidate forwarding
      pc.onicecandidate = (event) => {
        if (!event.candidate) return; // End-of-candidates signal
        try {
          // node-datachannel's RTCIceCandidate uses prototype getters that
          // don't survive object spread. Use toJSON() if available, otherwise
          // manually extract the fields browsers need.
          const raw = event.candidate;
          const candidate = typeof raw.toJSON === "function"
            ? raw.toJSON()
            : { candidate: raw.candidate, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex };

          // node-datachannel may emit ICE candidates with an "a=" prefix
          // that browsers don't expect. Strip it before sending to the client.
          if (typeof candidate.candidate === "string" && candidate.candidate.startsWith("a=")) {
            candidate.candidate = candidate.candidate.slice(2);
          }

          onSend(clientId, {
            type: "rtc-ice-candidate",
            candidate,
          });
        } catch (err) {
          log.error("Failed to send ICE candidate", { clientId, error: err?.message || String(err) });
        }
      };

      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      log.info("WebRTC: answer sent", { clientId });

      onSend(clientId, {
        type: "rtc-answer",
        sdp: answer.sdp,
      });
    } catch (err) {
      log.error("WebRTC handleOffer failed", { clientId, error: err?.message || String(err) });
      // Clean up on failure
      const pc = peerConnections.get(clientId);
      if (pc) {
        try { pc.close(); } catch {}
        peerConnections.delete(clientId);
      }
    }
  }

  /**
   * Handle an rtc-ice-candidate message from a client.
   *
   * @param {string} clientId
   * @param {object} candidate - ICE candidate object
   */
  async function handleCandidate(clientId, candidate) {
    try {
      const pc = peerConnections.get(clientId);
      if (!pc) {
        log.debug("ICE candidate for unknown client (ignored)", { clientId });
        return;
      }
      // Extract only expected fields — don't pass arbitrary objects to the
      // native WebRTC stack. Defense-in-depth against prototype pollution
      // or type-confusion in the node-datachannel binding.
      await pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    } catch (err) {
      log.error("WebRTC handleCandidate failed", { clientId, error: err?.message || String(err) });
    }
  }

  /**
   * Clean up peer connection when a client disconnects.
   * Idempotent — safe to call multiple times or for unknown clients.
   *
   * @param {string} clientId
   */
  function handleDisconnect(clientId) {
    const pc = peerConnections.get(clientId);
    if (!pc) return;
    try { pc.close(); } catch {}
    peerConnections.delete(clientId);
  }

  /**
   * Test-only: retrieve the peer connection for a client.
   * Allows tests to simulate events (ondatachannel, onicecandidate)
   * on the mock peer connection.
   *
   * @param {string} clientId
   * @returns {RTCPeerConnection|undefined}
   */
  function _getPeerConnection(clientId) {
    return peerConnections.get(clientId);
  }

  return {
    handleOffer,
    handleCandidate,
    handleDisconnect,
    _getPeerConnection,
  };
}
