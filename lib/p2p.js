import SimplePeer from "simple-peer";
import { log } from "./log.js";
import { getDefaultAddress } from "./lan.js";

let nodeDataChannel = null;
export let p2pAvailable = false;
let preferredAddress = null;

export async function initP2P() {
  try {
    nodeDataChannel = (await import("node-datachannel/polyfill")).default;
    p2pAvailable = true;
    preferredAddress = await getDefaultAddress();
    log.info("P2P WebRTC available (node-datachannel loaded)", { preferredAddress });
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

  peer.on("signal", (data) => {
    if (data.candidate) {
      const c = data.candidate.candidate;
      log.info("P2P local candidate", { candidate: c });

      // On multi-NIC hosts, only send host candidates from the default route
      // interface. A socket bound to 0.0.0.0 routes responses through the
      // default interface regardless of which IP the peer targeted, so
      // candidates on other interfaces cause ICE to fail (wrong source IP).
      if (preferredAddress && c.includes("typ host")) {
        const fields = c.replace(/^a=/, "").split(/\s+/);
        const ip = fields[4]; // candidate:<fn> <comp> <proto> <pri> <IP> <port> typ host
        if (ip && ip !== preferredAddress) {
          log.info("P2P filtering candidate (non-default interface)", {
            candidate: c, preferred: preferredAddress,
          });
          return;
        }
      }
    } else if (data.type) {
      log.info("P2P signal", { type: data.type });
    }
    onSignal(data);
  });

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
