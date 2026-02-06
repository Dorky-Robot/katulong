import SimplePeer from "simple-peer";
import nodeDataChannel from "node-datachannel/polyfill";
import { log } from "./log.js";

export function createServerPeer(onSignal, onData, onClose) {
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
