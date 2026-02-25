/**
 * WebSocket client manager.
 *
 * Manages the wsClients Map, session routing, P2P peer lifecycle,
 * and bridge subscriber registration. Extracted from server.js (#132/#112).
 */

import { randomUUID } from "node:crypto";
import { createServerPeer, destroyPeer, p2pAvailable } from "./p2p.js";
import { validateMessage } from "./websocket-validation.js";
import { loadState } from "./auth.js";
import { log } from "./log.js";

/**
 * Create a WebSocket manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge
 * @param {Function} opts.daemonRPC - RPC function
 * @param {Function} opts.daemonSend - Fire-and-forget send
 * @returns {object} Manager API
 */
export function createWebSocketManager({ bridge, daemonRPC, daemonSend }) {
  const wsClients = new Map(); // clientId -> { ws, session, sessionToken, credentialId, p2pPeer, p2pConnected }

  function sendToSession(sessionName, payload, { preferP2P = false } = {}) {
    const encoded = JSON.stringify(payload);
    for (const [, info] of wsClients) {
      if (info.session !== sessionName) continue;
      if (preferP2P && info.p2pConnected && info.p2pPeer) {
        try {
          info.p2pPeer.send(encoded);
          continue;
        } catch { /* fall through to WS */ }
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

  function closeAllWebSockets(code, reason) {
    for (const [clientId, info] of wsClients) {
      if (info.ws.readyState === 1) {
        info.ws.close(code, reason);
      }
      wsClients.delete(clientId);
    }
  }

  function closeWebSocketsForCredential(credentialId) {
    let closedCount = 0;
    for (const [clientId, info] of wsClients) {
      if (info.credentialId === credentialId) {
        log.info("Closing WebSocket for revoked credential", { clientId, credentialId });

        if (info.p2pPeer) {
          try { destroyPeer(info.p2pPeer); } catch (err) {
            log.warn("Error destroying P2P peer", { error: err.message });
          }
        }

        if (info.ws.readyState === 1) {
          info.ws.close(1008, "Credential revoked");
        }

        wsClients.delete(clientId);
        closedCount++;
      }
    }

    if (closedCount > 0) {
      log.info("Closed WebSocket connections for revoked credential", { credentialId, count: closedCount });
    }
  }

  // Register bridge subscriber for daemon broadcasts
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

  function handleConnection(ws) {
    const clientId = randomUUID();
    log.debug("Client connected", { clientId });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

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
          wsClients.delete(clientId);
          return;
        }
      }

      const wsMessageHandlers = {
        async attach() {
          const name = msg.session || "default";
          try {
            const result = await daemonRPC({ type: "attach", clientId, session: name, cols: msg.cols, rows: msg.rows });
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
            ws.send(JSON.stringify({ type: "error", message: "Daemon not available" }));
          }
        },
        input() {
          daemonSend({ type: "input", clientId, data: msg.data });
        },
        resize() {
          daemonSend({ type: "resize", clientId, cols: msg.cols, rows: msg.rows });
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
                  if (p2pMsg.type === "input") daemonSend({ type: "input", clientId, data: p2pMsg.data });
                } catch (err) { log.warn("Malformed P2P data", { clientId, error: err.message }); }
              },
              () => {
                const cur = wsClients.get(clientId);
                if (cur) { cur.p2pPeer = null; cur.p2pConnected = false; }
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-closed" }));
              }
            );
            info.p2pPeer.on("connect", () => {
              const cur = wsClients.get(clientId);
              if (cur) cur.p2pConnected = true;
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-ready" }));
            });
          }
          info.p2pPeer.signal(msg.data);
        },
      };

      const handler = wsMessageHandlers[msg.type];
      if (handler) await handler();
    });

    ws.on("error", (err) => {
      log.error("WebSocket client error", { clientId, error: err.message });
      const info = wsClients.get(clientId);
      if (info?.p2pPeer) destroyPeer(info.p2pPeer);
      wsClients.delete(clientId);
      daemonSend({ type: "detach", clientId });
    });

    ws.on("close", () => {
      log.debug("Client disconnected", { clientId });
      const info = wsClients.get(clientId);
      if (info?.p2pPeer) destroyPeer(info.p2pPeer);
      wsClients.delete(clientId);
      daemonSend({ type: "detach", clientId });
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
