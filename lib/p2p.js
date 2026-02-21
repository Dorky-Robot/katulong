import { log } from "./log.js";

// DEPRECATED: WebRTC P2P transport is deprecated and will be removed in a
// future release. Use WebSocket over a tunnel service (cloudflared, ngrok,
// Cloudflare Tunnel, etc.) for remote access instead. WebSocket is the sole
// supported transport for terminal I/O.
let _warned = false;
function warnDeprecated() {
  if (!_warned) {
    _warned = true;
    log.warn(
      "DEPRECATED: WebRTC P2P transport is deprecated and will be removed. " +
      "Use WebSocket over a tunnel service (cloudflared, ngrok, Cloudflare Tunnel) " +
      "for remote access — WebSocket is the sole supported transport for terminal I/O.",
    );
  }
}

export let p2pAvailable = false;

export async function initP2P() {
  warnDeprecated();
  p2pAvailable = false;
  log.warn("P2P WebRTC unavailable — WebRTC P2P support has been removed, use WebSocket instead");
}

export function createServerPeer(_onSignal, _onData, _onClose) {
  warnDeprecated();
  return null;
}

export function destroyPeer(peer) {
  if (!peer) return;
  try {
    peer.destroy();
  } catch {
    // already destroyed
  }
}
