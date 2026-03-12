import { log } from "./log.js";
import { getDefaultAddress } from "./lan.js";

let wrtc = null;
export let p2pAvailable = false;
let preferredAddress = null;

export async function initP2P() {
  try {
    wrtc = (await import("node-datachannel/polyfill")).default;
    p2pAvailable = true;
    preferredAddress = await getDefaultAddress();
    log.info("P2P WebRTC available (node-datachannel loaded)", { preferredAddress });
  } catch (err) {
    p2pAvailable = false;
    log.warn("P2P WebRTC unavailable — falling back to WebSocket only", { error: err.message });
  }
}

/**
 * Strip the `a=` SDP attribute prefix that node-datachannel's polyfill adds
 * to candidate strings. Browser RTCPeerConnection expects the bare
 * `candidate:...` format.
 */
export function stripCandidatePrefix(c) {
  return c.startsWith("a=") ? c.slice(2) : c;
}

/**
 * Filter host ICE candidates to only include the default network interface.
 */
function shouldSendCandidate(candidateStr) {
  if (!preferredAddress || !candidateStr.includes("typ host")) return true;
  // Normalize away the optional `a=` prefix before parsing fields
  const bare = stripCandidatePrefix(candidateStr);
  const fields = bare.split(/\s+/);
  // candidate:<fn> <comp> <proto> <pri> <IP> <port> typ host
  const ip = fields[4];
  if (ip && ip !== preferredAddress) {
    log.info("P2P filtering candidate (non-default interface)", {
      candidate: candidateStr, preferred: preferredAddress,
    });
    return false;
  }
  return true;
}

/**
 * Create a server-side WebRTC peer using the polyfill's RTCPeerConnection API.
 *
 * Uses the browser-compatible RTCPeerConnection from node-datachannel/polyfill
 * directly (without SimplePeer) to avoid SDP mutation issues.
 *
 * The client (browser) is the initiator. The server is the responder.
 *
 * @param {function} onSignal - Called with signaling data to send to client
 * @param {function} onData - Called with incoming DataChannel messages
 * @param {function} onClose - Called when the connection closes
 * @param {function} onConnect - Called when the DataChannel opens
 * @returns {object} Peer wrapper with signal() / send() / destroy()
 */
export function createServerPeer(onSignal, onData, onClose, onConnect) {
  if (!p2pAvailable) return null;

  const pc = new wrtc.RTCPeerConnection({ iceServers: [] });
  let dc = null;
  let closed = false;

  function cleanup() {
    if (closed) return;
    closed = true;
    log.info("P2P DataChannel closed");
    try { pc.close(); } catch { /* ignore */ }
    onClose();
  }

  // ICE candidate trickle — send server candidates to client
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    const c = event.candidate.candidate;
    log.info("P2P local candidate", { candidate: c });
    if (!shouldSendCandidate(c)) return;
    // Strip `a=` prefix that node-datachannel polyfill adds — browsers
    // expect the bare `candidate:...` format.
    const json = event.candidate.toJSON();
    json.candidate = stripCandidatePrefix(json.candidate);
    onSignal({ candidate: json });
  };

  pc.oniceconnectionstatechange = () => {
    log.info("P2P server ICE state", { state: pc.iceConnectionState });
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
      cleanup();
    }
  };

  // Receive the DataChannel created by the initiator (client)
  pc.ondatachannel = (event) => {
    dc = event.channel;
    log.info("P2P received DataChannel", { label: dc.label });

    dc.onopen = () => {
      log.info("P2P DataChannel connected");
      if (onConnect) onConnect();
    };

    dc.onmessage = (event) => {
      onData(event.data);
    };

    dc.onclose = () => cleanup();
    dc.onerror = (err) => {
      log.warn("P2P DataChannel error", { error: err?.message || err });
      cleanup();
    };
  };

  return {
    /**
     * Feed signaling data from the client (offers, answers, ICE candidates).
     */
    async signal(data) {
      try {
        if (data.type === "offer") {
          log.info("P2P signal", { type: "offer" });
          await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          log.info("P2P signal", { type: "answer" });
          onSignal({ type: answer.type, sdp: answer.sdp });
        } else if (data.candidate) {
          log.debug("P2P remote candidate", { candidate: data.candidate.candidate });
          await pc.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        log.warn("P2P signal error", { error: err.message });
      }
    },

    /**
     * Send data over the DataChannel.
     */
    send(data) {
      if (dc && dc.readyState === "open") {
        try { dc.send(data); } catch { /* ignore */ }
      }
    },

    /**
     * Destroy the peer connection.
     */
    destroy() {
      cleanup();
    },
  };
}

export function destroyPeer(peer) {
  if (!peer) return;
  try {
    peer.destroy();
  } catch {
    // already destroyed
  }
}
