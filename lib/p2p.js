import { lookup } from "node:dns/promises";
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

// RFC 8839 §5.1: candidate:<fn> <comp> <proto> <pri> <addr> <port> typ <type>
const SDP_CANDIDATE_ADDR_INDEX = 4;

// Only allow RFC 1918, link-local, and ULA addresses from mDNS resolution.
// Prevents DNS rebinding if the system resolver forwards .local queries
// to an attacker-controlled DNS server.
const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|fd)/;

const MDNS_LOOKUP_TIMEOUT_MS = 1000;
const MAX_SIGNAL_QUEUE_DEPTH = 50;

/**
 * Resolve mDNS (.local) hostnames in ICE candidates to real IPs.
 * Browsers hide real IPs behind random mDNS hostnames for privacy.
 * libdatachannel can't resolve mDNS internally, so we resolve via
 * the system DNS resolver (avahi/Bonjour) before passing to addIceCandidate.
 */
async function resolveMdnsCandidate(candidateObj) {
  const candidateStr = candidateObj.candidate;
  if (!candidateStr || !candidateStr.includes(".local")) return candidateObj;

  const fields = candidateStr.split(/\s+/);
  if (fields.length < 8) return candidateObj;
  const addr = fields[SDP_CANDIDATE_ADDR_INDEX];
  if (!addr || !addr.endsWith(".local")) return candidateObj;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MDNS_LOOKUP_TIMEOUT_MS);
    const { address } = await lookup(addr, { signal: ac.signal });
    clearTimeout(timer);

    if (!PRIVATE_IP.test(address)) {
      log.warn("P2P mDNS resolved to non-private IP, dropping candidate", { mdns: addr, resolved: address });
      return candidateObj;
    }

    log.debug("P2P resolved mDNS candidate", { mdns: addr, resolved: address });
    fields[SDP_CANDIDATE_ADDR_INDEX] = address;
    return { ...candidateObj, candidate: fields.join(" ") };
  } catch (err) {
    log.warn("P2P mDNS resolution failed", { mdns: addr, error: err.message });
    return candidateObj;
  }
}

/**
 * Filter host ICE candidates to only include the default network interface.
 */
function shouldSendCandidate(candidateStr) {
  if (!preferredAddress || !candidateStr.includes("typ host")) return true;
  const bare = stripCandidatePrefix(candidateStr);
  const fields = bare.split(/\s+/);
  const ip = fields[SDP_CANDIDATE_ADDR_INDEX];
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

  // Signal queue ensures ICE candidates are not processed before
  // setRemoteDescription completes (SimplePeer had internal queuing;
  // raw RTCPeerConnection does not).
  let signalQueue = Promise.resolve();
  let signalQueueDepth = 0;

  const peer = {
    /**
     * Feed signaling data from the client (offers, answers, ICE candidates).
     * Signals are serialized to prevent addIceCandidate racing ahead of
     * setRemoteDescription when offer + candidates arrive back-to-back.
     */
    signal(data) {
      if (signalQueueDepth >= MAX_SIGNAL_QUEUE_DEPTH) {
        log.warn("P2P signal queue full, dropping signal");
        return Promise.resolve();
      }
      signalQueueDepth++;
      signalQueue = signalQueue.then(async () => {
        try {
          if (closed) return;
          if (data.type === "offer") {
            log.info("P2P signal", { type: "offer" });
            await pc.setRemoteDescription(new wrtc.RTCSessionDescription(data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            log.info("P2P signal", { type: "answer" });
            onSignal({ type: answer.type, sdp: answer.sdp });
          } else if (data.candidate) {
            log.info("P2P remote candidate", { candidate: data.candidate.candidate });
            const resolved = await resolveMdnsCandidate(data.candidate);
            await pc.addIceCandidate(new wrtc.RTCIceCandidate(resolved));
          }
        } catch (err) {
          log.warn("P2P signal error", { error: err.message });
        } finally {
          signalQueueDepth--;
        }
      });
      return signalQueue;
    },

    /**
     * Send data over the DataChannel.
     * @returns {boolean} true if data was actually sent
     */
    send(data) {
      if (dc && dc.readyState === "open") {
        try { dc.send(data); return true; } catch { return false; }
      }
      return false;
    },

    /**
     * Destroy the peer connection.
     */
    destroy() {
      cleanup();
    },
  };

  return peer;
}

export function destroyPeer(peer) {
  if (!peer) return;
  try {
    peer.destroy();
  } catch {
    // already destroyed
  }
}
