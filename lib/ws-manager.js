/**
 * WebSocket client manager.
 *
 * Manages the wsClients Map, session routing, P2P peer lifecycle,
 * and bridge subscriber registration. Extracted from server.js (#132/#112).
 */

import { randomUUID } from "node:crypto";
import { createServerPeer, destroyPeer, p2pAvailable } from "./p2p.js";
import { validateMessage } from "./websocket-validation.js";
import { SessionName } from "./session-name.js";
import { loadState } from "./auth.js";
import { log } from "./log.js";
import { getLanAddresses } from "./lan.js";

/**
 * Create a WebSocket manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge
 * @param {object} opts.sessionManager - Session manager instance
 * @returns {object} Manager API
 */
export function createWebSocketManager({ bridge, sessionManager }) {
  const wsClients = new Map(); // clientId -> { ws, session, sessionToken, credentialId, p2pPeer, p2pConnected }

  function sendToSession(sessionName, payload, { preferP2P = false } = {}) {
    const encoded = JSON.stringify(payload);
    for (const [, info] of wsClients) {
      if (info.session !== sessionName) continue;
      if (preferP2P && info.p2pConnected && info.p2pPeer) {
        try {
          info.p2pPeer.send(encoded);
          continue;
        } catch (err) { log.debug("P2P send failed, falling through to WS", { error: err.message }); }
      }
      if (info.ws.readyState === 1) {
        info.ws.send(encoded);
      }
    }
  }

  function broadcastToAll(payload) {
    const encoded = JSON.stringify(payload);
    for (const [, info] of wsClients) {
      if (info.ws.readyState === 1) {
        info.ws.send(encoded);
      }
    }
  }

  function cleanupClient(clientId) {
    const info = wsClients.get(clientId);
    if (!info) return; // Already cleaned up (e.g., close event after closeAllWebSockets)
    if (info.p2pPeer) {
      try { destroyPeer(info.p2pPeer); } catch (err) {
        log.warn("Error destroying P2P peer", { clientId, error: err.message });
      }
    }
    wsClients.delete(clientId);
    sessionManager.detachClient(clientId);
  }

  function closeAllWebSockets(code, reason) {
    for (const [clientId, info] of wsClients) {
      if (info.ws.readyState === 1) {
        info.ws.close(code, reason);
      }
      cleanupClient(clientId);
    }
  }

  function closeWebSocketsForCredential(credentialId) {
    let closedCount = 0;
    for (const [clientId, info] of wsClients) {
      if (info.credentialId === credentialId) {
        log.info("Closing WebSocket for revoked credential", { clientId, credentialId });
        if (info.ws.readyState === 1) {
          info.ws.close(1008, "Credential revoked");
        }
        cleanupClient(clientId);
        closedCount++;
      }
    }

    if (closedCount > 0) {
      log.info("Closed WebSocket connections for revoked credential", { credentialId, count: closedCount });
    }
  }

  // Register bridge subscriber for session manager events
  bridge.register((msg) => {
    switch (msg.type) {
      case "output":
        sendToSession(msg.session, { type: "output", data: msg.data }, { preferP2P: true });
        break;
      case "exit":
        sendToSession(msg.session, { type: "exit", code: msg.code });
        break;
      case "session-removed":
        sendToSession(msg.session, { type: "session-removed" });
        break;
      case "session-renamed":
        sendToSession(msg.session, { type: "session-renamed", name: msg.newName });
        for (const [, info] of wsClients) {
          if (info.session === msg.session) info.session = msg.newName;
        }
        break;
      case "child-count-update":
        sendToSession(msg.session, { type: "child-count-update", count: msg.count });
        break;
    }
  });

  const PING_INTERVAL_MS = 30000;
  const MAX_MISSED_PONGS = 2;

  function handleConnection(ws) {
    const clientId = randomUUID();
    log.debug("Client connected", { clientId });

    // Heartbeat: ping every 30s, terminate after 2 missed pongs
    let missedPongs = 0;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; missedPongs = 0; });
    const pingTimer = setInterval(() => {
      if (!ws.isAlive) {
        missedPongs++;
        if (missedPongs >= MAX_MISSED_PONGS) {
          log.warn("WebSocket terminated: missed pongs", { clientId, missedPongs });
          clearInterval(pingTimer);
          ws.terminate();
          return;
        }
      }
      ws.isAlive = false;
      if (ws.readyState === 1) ws.ping();
    }, PING_INTERVAL_MS);

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; } // Malformed JSON — silently drop

      const validation = validateMessage(msg);
      if (!validation.valid) {
        log.warn("Invalid WebSocket message", { clientId, error: validation.error, type: msg?.type });
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        return;
      }

      if (ws.sessionToken) {
        const state = loadState();
        if (!state || !state.isValidSession(ws.sessionToken)) {
          log.warn("WebSocket message rejected: session no longer valid", { clientId, credentialId: ws.credentialId });
          ws.close(1008, "Session invalidated");
          cleanupClient(clientId);
          return;
        }
      }

      function resolveSessionName(raw) {
        const parsed = SessionName.tryCreate(raw || "default");
        return parsed ? parsed.value : null;
      }

      const wsMessageHandlers = {
        async attach() {
          const name = resolveSessionName(msg.session);
          if (!name) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            wsClients.set(clientId, {
              ws, session: name, sessionToken: ws.sessionToken,
              credentialId: ws.credentialId, p2pPeer: null, p2pConnected: false,
            });
            log.debug("Client attached", { clientId, session: name });
            ws.send(JSON.stringify({ type: "attached" }));
            if (result.buffer) ws.send(JSON.stringify({ type: "output", data: result.buffer }));
            if (!result.alive) ws.send(JSON.stringify({ type: "exit", code: -1 }));
          } catch (err) {
            log.error("Attach failed", { clientId, error: err.message });
            ws.send(JSON.stringify({ type: "error", message: "Session manager error" }));
          }
        },
        async switch() {
          const name = resolveSessionName(msg.session);
          if (!name) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            // Just re-point the client at the new session — all tmux control
            // mode processes stay attached in the background.
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            const info = wsClients.get(clientId);
            if (info) info.session = name;
            log.debug("Client switched session", { clientId, session: name });
            ws.send(JSON.stringify({ type: "switched", session: name }));
            if (result.buffer) ws.send(JSON.stringify({ type: "output", data: result.buffer }));
            if (!result.alive) ws.send(JSON.stringify({ type: "exit", code: -1 }));
          } catch (err) {
            log.error("Switch failed", { clientId, error: err.message });
            ws.send(JSON.stringify({ type: "error", message: "Session switch error" }));
          }
        },
        input() {
          sessionManager.writeInput(clientId, msg.data);
        },
        resize() {
          sessionManager.resizeClient(clientId, msg.cols, msg.rows);
        },
        "p2p-signal"() {
          const info = wsClients.get(clientId);
          if (!info) return;
          if (!p2pAvailable) {
            ws.send(JSON.stringify({ type: "p2p-unavailable" }));
            return;
          }
          if (msg.data?.type === "offer" && info.p2pPeer) {
            destroyPeer(info.p2pPeer);
            info.p2pPeer = null;
            info.p2pConnected = false;
          }
          if (!info.p2pPeer) {
            info.p2pPeer = createServerPeer(
              (data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-signal", data })); },
              (chunk) => {
                try {
                  const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                  const p2pMsg = JSON.parse(str);
                  if (p2pMsg.type === "input" && typeof p2pMsg.data === "string") sessionManager.writeInput(clientId, p2pMsg.data);
                } catch (err) { log.warn("Malformed P2P data", { clientId, error: err.message }); }
              },
              () => {
                const cur = wsClients.get(clientId);
                if (cur) { cur.p2pPeer = null; cur.p2pConnected = false; }
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-closed" }));
              },
              () => {
                const cur = wsClients.get(clientId);
                if (cur) cur.p2pConnected = true;
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-ready" }));
              }
            );

            // Send server LAN IPs so client can log candidate comparison
            const lanAddresses = getLanAddresses();
            log.info("P2P server LAN addresses", { addresses: lanAddresses });
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "p2p-lan-candidates", addresses: lanAddresses }));
            }
          }
          info.p2pPeer.signal(msg.data);
        },
      };

      const handler = wsMessageHandlers[msg.type];
      if (handler) {
        try {
          await handler();
        } catch (err) {
          log.error("WebSocket handler error", { clientId, type: msg.type, error: err.message });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
          }
        }
      }
    });

    ws.on("error", (err) => {
      log.error("WebSocket client error", { clientId, error: err.message });
      clearInterval(pingTimer);
      cleanupClient(clientId);
    });

    ws.on("close", () => {
      log.debug("Client disconnected", { clientId });
      clearInterval(pingTimer);
      cleanupClient(clientId);
    });
  }

  return {
    wsClients,
    sendToSession,
    broadcastToAll,
    closeAllWebSockets,
    closeWebSocketsForCredential,
    handleConnection,
  };
}
