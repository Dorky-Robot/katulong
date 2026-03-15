/**
 * WebSocket client manager.
 *
 * Manages the wsClients Map, session routing, P2P peer lifecycle,
 * and bridge subscriber registration. Extracted from server.js (#132/#112).
 *
 * Session binding (which client views which session) is owned exclusively
 * by the client-tracker inside session-manager. The wsClients Map here
 * stores only transport and auth concerns — no session field.
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
export function createWebSocketManager({ bridge, sessionManager, helmSessionManager }) {
  // clientId -> { ws, sessionToken, credentialId, p2pPeer, p2pConnected }
  // Note: session binding lives in the client-tracker (single source of truth).
  const wsClients = new Map();

  // Drop output for slow clients to prevent unbounded server memory growth.
  // 1MB threshold — enough for ~20 full terminal screens of buffered output.
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

  function sendToSession(sessionName, payload, { preferP2P = false } = {}) {
    const encoded = JSON.stringify(payload);
    for (const [clientId, info] of wsClients) {
      if (sessionManager.getSessionForClient(clientId) !== sessionName) continue;
      if (preferP2P && info.p2pConnected && info.p2pPeer) {
        try {
          info.p2pPeer.send(encoded);
          continue;
        } catch (err) { log.debug("P2P send failed, falling through to WS", { error: err.message }); }
      }
      if (info.ws.readyState !== 1) continue;
      // Skip output for slow clients — they'll get a full buffer replay on reconnect
      if (payload.type === "output" && info.ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
        log.debug("Dropping output for slow client", { clientId, buffered: info.ws.bufferedAmount });
        continue;
      }
      info.ws.send(encoded);
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

  function sendToSessionExcluding(sessionName, excludeClientId, payload) {
    const encoded = JSON.stringify(payload);
    for (const [clientId, info] of wsClients) {
      if (sessionManager.getSessionForClient(clientId) !== sessionName) continue;
      if (clientId === excludeClientId) continue;
      if (info.ws.readyState === 1) {
        info.ws.send(encoded);
      }
    }
  }

  // Bridge subscriber — routes session-manager events to WebSocket clients
  bridge.register((msg) => {
    switch (msg.type) {
      // Session I/O routing
      case "output":
        sendToSession(msg.session, { type: "output", session: msg.session, data: msg.data }, { preferP2P: true });
        break;
      case "exit":
        sendToSession(msg.session, { type: "exit", session: msg.session, code: msg.code });
        break;
      case "child-count-update":
        sendToSession(msg.session, { type: "child-count-update", count: msg.count });
        break;

      // Session lifecycle
      case "session-removed":
        sendToSession(msg.session, { type: "session-removed", session: msg.session });
        break;
      case "session-renamed":
        // Tracker already renamed clients before relay, so route via newName
        sendToSession(msg.newName, { type: "session-renamed", name: msg.newName });
        break;
      case "resize-sync":
        sendToSessionExcluding(msg.session, msg.activeClientId, {
          type: "resize-sync", cols: msg.cols, rows: msg.rows,
        });
        break;

      // Claude session events (relayed from yolo → browser clients)
      case "helm-mode-changed":
        sendToSession(msg.session, {
          type: "helm-mode-changed", session: msg.session,
          active: msg.active, prompt: msg.prompt, cwd: msg.cwd,
          result: msg.result, error: msg.error,
        });
        break;
      case "helm-event":
        sendToSession(msg.session, {
          type: "helm-event", session: msg.session, event: msg.event,
        });
        break;
      case "helm-turn-complete":
        sendToSession(msg.session, { type: "helm-turn-complete", session: msg.session });
        break;
      case "helm-waiting-for-input":
        sendToSession(msg.session, { type: "helm-waiting-for-input", session: msg.session });
        break;

      // Auth & transport lifecycle
      case "credential-registered":
        broadcastToAll({ type: "credential-registered", tokenId: msg.tokenId });
        break;
      case "close-all-websockets":
        closeAllWebSockets(msg.code, msg.reason);
        break;
      case "close-credential-websockets":
        closeWebSocketsForCredential(msg.credentialId);
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

    // Serialize async message handling per client to prevent interleaving
    // (e.g., two rapid attach messages racing each other).
    let messageQueue = Promise.resolve();

    ws.on("message", (raw) => {
      messageQueue = messageQueue.then(() => handleMessage(raw)).catch((err) => {
        log.warn("Unexpected message handler error", { clientId, error: err?.message });
      });
    });

    async function handleMessage(raw) {
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
        if (!state || !state.isValidLoginToken(ws.sessionToken)) {
          log.warn("WebSocket message rejected: session no longer valid", { clientId, credentialId: ws.credentialId });
          ws.close(1008, "Session invalidated");
          cleanupClient(clientId);
          return;
        }
      }

      function resolveSessionName(raw) {
        const parsed = raw ? SessionName.tryCreate(raw) : null;
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
              ws, sessionToken: ws.sessionToken,
              credentialId: ws.credentialId, p2pPeer: null, p2pConnected: false,
            });
            log.debug("Client attached", { clientId, session: name });
            ws.send(JSON.stringify({ type: "attached", session: name }));
            if (result.buffer) ws.send(JSON.stringify({ type: "output", session: name, data: result.buffer }));
            if (!result.alive) ws.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
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
            // Session binding is updated by tracker.attach() inside attachClient.
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client switched", { clientId, session: name });
            ws.send(JSON.stringify({ type: "switched", session: name }));
            // Only send buffer replay for fresh terminals — cached terminals already have content
            if (result.buffer && !msg.cached) ws.send(JSON.stringify({ type: "output", session: name, data: result.buffer }));
            if (!result.alive) ws.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
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
        "helm-input"() {
          if (helmSessionManager) {
            const delivered = helmSessionManager.sendUserMessage(msg.session, msg.content);
            if (!delivered) {
              ws.send(JSON.stringify({ type: "error", message: "No active helm session for this terminal" }));
            }
          }
        },
        "helm-tool-response"() {
          if (helmSessionManager) {
            helmSessionManager.sendToolResponse(msg.session, msg.id, msg.approved);
          }
        },
        "helm-abort"() {
          if (helmSessionManager) {
            helmSessionManager.abortSession(msg.session);
          }
        },
        "set-tab-icon"() {
          const name = resolveSessionName(msg.session);
          if (!name) return;
          const session = sessionManager.getSession(name);
          if (!session) return;
          session.setIcon(msg.icon || null);
          log.debug("Tab icon changed", { clientId, session: name, icon: session.icon });
          // Notify only clients viewing this session (not all connected clients)
          sendToSession(name, { type: "tab-icon-changed", session: name, icon: session.icon });
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
    }

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
    handleConnection,
  };
}
