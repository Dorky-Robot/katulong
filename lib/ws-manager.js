/**
 * WebSocket client manager.
 *
 * Manages the wsClients Map, session routing, and bridge subscriber
 * registration. Extracted from server.js (#132/#112).
 *
 * Session binding (which client views which session) is owned exclusively
 * by the client-tracker inside session-manager. The wsClients Map here
 * stores only transport and auth concerns — no session field.
 */

import { randomUUID } from "node:crypto";
import { validateMessage } from "./websocket-validation.js";
import { SessionName } from "./session-name.js";
import { loadState } from "./auth.js";
import { log } from "./log.js";

/**
 * Create a WebSocket manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge
 * @param {object} opts.sessionManager - Session manager instance
 * @returns {object} Manager API
 */
export function createWebSocketManager({ bridge, sessionManager, helmSessionManager, pluginWsHandlers = {} }) {
  // clientId -> { ws, sessionToken, credentialId }
  // Note: session binding lives in the client-tracker (single source of truth).
  const wsClients = new Map();

  // Drop output for slow clients to prevent unbounded server memory growth.
  // 1MB threshold — enough for ~20 full terminal screens of buffered output.
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

  function sendToSession(sessionName, payload) {
    const encoded = JSON.stringify(payload);
    for (const [clientId, info] of wsClients) {
      if (!sessionManager.isClientSubscribedTo(clientId, sessionName)) continue;
      if (info.ws.readyState !== 1) continue;
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
      if (!sessionManager.isClientSubscribedTo(clientId, sessionName)) continue;
      if (clientId === excludeClientId) continue;
      if (info.ws.readyState === 1) {
        info.ws.send(encoded);
      }
    }
  }

  // Bridge subscriber — routes session-manager events to WebSocket clients
  bridge.register((msg) => {
    switch (msg.type) {
      // Screen update — changed rows + cursor position
      case "screen":
        sendToSession(msg.session, {
          type: "screen", session: msg.session,
          rows: msg.rows, cx: msg.cx, cy: msg.cy,
        });
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

      // Clipboard paste progress
      case "paste-complete":
        sendToSession(msg.session, { type: "paste-complete", path: msg.path });
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
            // Register in routing table BEFORE attachClient so snapshots
            // from the session's loop reach this client immediately.
            wsClients.set(clientId, {
              ws, sessionToken: ws.sessionToken,
              credentialId: ws.credentialId,
            });
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client attached", { clientId, session: name });
            ws.send(JSON.stringify({ type: "attached", session: name }));
            // Send initial screen state directly (snapshots from the loop may
            // have fired before tracker registered the client)
            if (result.buffer) {
              const lines = result.buffer.split("\n");
              if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
              // Send all rows as initial screen state
              const rows = lines.map((content, i) => [i, content]);
              ws.send(JSON.stringify({ type: "screen", session: name, rows, cx: 0, cy: 0 }));
            }
            if (!result.alive) ws.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
          } catch (err) {
            // Ensure client is routable so cleanupClient can detach the
            // tracker entry on disconnect (attachClient may have succeeded
            // but a ws.send threw due to socket closing mid-sequence).
            if (!wsClients.has(clientId)) {
              wsClients.set(clientId, {
                ws, sessionToken: ws.sessionToken,
                credentialId: ws.credentialId, p2pPeer: null, p2pConnected: false,
              });
            }
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
          // Hoist outside try so it's visible in the catch block for restore
          const info = wsClients.get(clientId);
          try {
            // Ensure routing is set before attachClient so snapshots reach the client
            wsClients.set(clientId, info || {
              ws, sessionToken: ws.sessionToken,
              credentialId: ws.credentialId,
            });
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client switched", { clientId, session: name });
            ws.send(JSON.stringify({ type: "switched", session: name }));

            if (!result.alive) ws.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
          } catch (err) {
            // Restore routing on failure so the client isn't left unroutable
            if (info && !wsClients.has(clientId)) wsClients.set(clientId, info);
            log.error("Switch failed", { clientId, error: err.message });
            ws.send(JSON.stringify({ type: "error", message: "Session switch error" }));
          }
        },
        input() {
          const session = msg.session ? resolveSessionName(msg.session) : undefined;
          sessionManager.writeInput(clientId, msg.data, session);
        },
        resize() {
          if (msg.session) {
            // Explicit session (e.g. carousel card) — resize that session's PTY
            // directly so TUIs reflow at the card's dimensions.
            const name = resolveSessionName(msg.session);
            if (name) sessionManager.resizeSession(name, msg.cols, msg.rows);
          } else {
            sessionManager.resizeClient(clientId, msg.cols, msg.rows);
          }
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
        async subscribe() {
          const name = resolveSessionName(msg.session);
          if (!name) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            const result = await sessionManager.subscribeClient(clientId, name);
            log.debug("Client subscribed", { clientId, session: name });
            ws.send(JSON.stringify({ type: "subscribed", session: name }));
            // Send immediate snapshot so carousel tiles show existing content
            if (result.buffer) {
              const lines = result.buffer.split("\n");
              if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
              ws.send(JSON.stringify({ type: "screen", session: name, rows: lines.map((c, i) => [i, c]), cx: 0, cy: 0 }));
            }
            if (!result.alive) {
              ws.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
            }
          } catch (err) {
            log.warn("Subscribe failed", { clientId, session: name, error: err.message });
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          }
        },
        async unsubscribe() {
          const name = resolveSessionName(msg.session);
          if (!name) return;
          sessionManager.unsubscribeClient(clientId, name);
          log.debug("Client unsubscribed", { clientId, session: name });
          ws.send(JSON.stringify({ type: "unsubscribed", session: name }));
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
      };

      const handler = wsMessageHandlers[msg.type] || null;
      if (handler) {
        try {
          await handler();
        } catch (err) {
          log.error("WebSocket handler error", { clientId, type: msg.type, error: err.message });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "error", message: "Internal error" }));
          }
        }
      } else if (pluginWsHandlers[msg.type]) {
        try {
          await pluginWsHandlers[msg.type](ws, msg, clientId);
        } catch (err) {
          log.error("Plugin WebSocket handler error", { clientId, type: msg.type, error: err.message });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "error", message: "Plugin error" }));
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
