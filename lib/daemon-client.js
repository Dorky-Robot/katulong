/**
 * Daemon IPC client.
 *
 * Manages the Unix socket connection to the PTY daemon, with automatic
 * reconnection and NDJSON-based RPC.
 */

import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { encode, decoder } from "./ndjson.js";

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function createDaemonClient({ socketPath, log, bridge }) {
  let socket = null;
  let connected = false;
  let reconnectDelay = RECONNECT_INITIAL_MS;
  const pendingRPC = new Map();

  function connect() {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }

    socket = createConnection(socketPath);

    socket.on("connect", () => {
      connected = true;
      reconnectDelay = RECONNECT_INITIAL_MS;
      log.info("Connected to daemon");
    });

    socket.on("data", decoder((msg) => {
      if (msg.id && pendingRPC.has(msg.id)) {
        const { resolve, timer } = pendingRPC.get(msg.id);
        clearTimeout(timer);
        pendingRPC.delete(msg.id);
        resolve(msg);
      } else {
        bridge.relay(msg);
      }
    }));

    socket.on("close", () => {
      connected = false;
      log.warn("Disconnected from daemon", { reconnectMs: reconnectDelay });
      for (const [, { reject, timer }] of pendingRPC) {
        clearTimeout(timer);
        reject(new Error("Daemon disconnected"));
      }
      pendingRPC.clear();
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    socket.on("error", (err) => {
      if (err.code !== "ENOENT" && err.code !== "ECONNREFUSED") {
        log.error("Daemon socket error", { error: err.message });
      }
    });
  }

  function rpc(msg, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!connected) return reject(new Error("Daemon not connected"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        pendingRPC.delete(id);
        reject(new Error("RPC timeout"));
      }, timeoutMs);
      pendingRPC.set(id, { resolve, reject, timer });
      socket.write(encode({ id, ...msg }));
    });
  }

  function send(msg) {
    if (connected) socket.write(encode(msg));
  }

  function disconnect() {
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
    connected = false;
  }

  return {
    connect,
    rpc,
    send,
    disconnect,
    isConnected: () => connected,
  };
}
