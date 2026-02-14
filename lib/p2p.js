import SimplePeer from "simple-peer";
import { log } from "./log.js";

let nodeDataChannel = null;
export let p2pAvailable = false;

export async function initP2P() {
  try {
    nodeDataChannel = (await import("node-datachannel/polyfill")).default;
    p2pAvailable = true;
    log.info("P2P WebRTC available (node-datachannel loaded)");
  } catch (err) {
    p2pAvailable = false;
    log.warn("P2P WebRTC unavailable — falling back to WebSocket only", { error: err.message });
  }
}

export function createServerPeer(onSignal, onData, onClose) {
  if (!p2pAvailable) return null;

  const peer = new SimplePeer({
    initiator: false,
    trickle: true,
    wrtc: nodeDataChannel,
    config: { iceServers: [] },
  });

  peer.on("signal", (data) => onSignal(data));

  peer.on("data", (chunk) => onData(chunk));

  peer.on("connect", () => {
    log.info("P2P DataChannel connected");
  });

  peer.on("close", () => {
    log.info("P2P DataChannel closed");
    onClose();
  });

  peer.on("error", (err) => {
    log.warn("P2P peer error", { error: err.message });
    onClose();
  });

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
