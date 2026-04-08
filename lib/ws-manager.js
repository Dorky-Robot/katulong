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
import { createClientTransport } from "./client-transport.js";
import { createWebRTCSignaling } from "./webrtc-signaling.js";

/**
 * Create a WebSocket manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge
 * @param {object} opts.sessionManager - Session manager instance
 * @returns {object} Manager API
 */
export function createWebSocketManager({ bridge, sessionManager, helmSessionManager, pluginWsHandlers = {} }) {
  // clientId -> { transport, sessionToken, credentialId }
  // transport is a ClientTransport wrapping WS + optional DataChannel.
  // Note: session binding lives in the client-tracker (single source of truth).
  const wsClients = new Map();

  // WebRTC signaling — manages per-client RTCPeerConnection lifecycle.
  // DataChannel established → upgrade the client's transport atomically.
  const signaling = createWebRTCSignaling({
    onDataChannel: (clientId, dc) => {
      const info = wsClients.get(clientId);
      if (info) {
        info.transport.upgradeToDataChannel(dc);
        log.info("Client upgraded to DataChannel", { clientId });
      }
    },
    onSend: (clientId, msg) => {
      const info = wsClients.get(clientId);
      // Signaling always goes over WebSocket (DC may not exist yet)
      if (info?.transport.ws.readyState === 1) {
        info.transport.ws.send(JSON.stringify(msg));
      }
    },
  });

  function sendToSession(sessionName, payload) {
    const encoded = JSON.stringify(payload);
    for (const [clientId, info] of wsClients) {
      if (!sessionManager.isClientSubscribedTo(clientId, sessionName)) continue;
      if (info.transport.readyState !== 1) continue;
      info.transport.send(encoded);
    }
  }

  function broadcastToAll(payload) {
    const encoded = JSON.stringify(payload);
    for (const [, info] of wsClients) {
      if (info.transport.readyState === 1) {
        info.transport.send(encoded);
      }
    }
  }

  function cleanupClient(clientId) {
    const info = wsClients.get(clientId);
    if (!info) return; // Already cleaned up (e.g., close event after closeAllWebSockets)
    wsClients.delete(clientId);
    signaling.handleDisconnect(clientId);
    sessionManager.detachClient(clientId);
  }

  function closeAllWebSockets(code, reason) {
    for (const [clientId, info] of wsClients) {
      if (info.transport.ws.readyState === 1) {
        info.transport.ws.close(code, reason);
      }
      cleanupClient(clientId);
    }
  }

  function closeWebSocketsForCredential(credentialId) {
    let closedCount = 0;
    for (const [clientId, info] of wsClients) {
      if (info.credentialId === credentialId) {
        log.info("Closing WebSocket for revoked credential", { clientId, credentialId });
        if (info.transport.ws.readyState === 1) {
          info.transport.ws.close(1008, "Credential revoked");
        }
        cleanupClient(clientId);
        closedCount++;
      }
    }

    if (closedCount > 0) {
      log.info("Closed WebSocket connections for revoked credential", { credentialId, count: closedCount });
    }
  }

  // Bridge subscriber — routes session-manager events to WebSocket clients
  bridge.register((msg) => {
    switch (msg.type) {
      // Session I/O routing — push raw bytes inline to all clients
      // subscribed to this session. Under Raptor 3 there is no pull
      // path and no backpressure-pull fallback: if a client's socket
      // is slow, the server-side ws send buffer holds the bytes until
      // drain. The bytes are the exact %output tmux emitted at the
      // current PTY dims; clients are guaranteed to be at matching
      // dims because the only way dims change is via a `snapshot`
      // message, which is serialized-after the last `output` at old
      // dims and serialized-before any `output` at new dims.
      case "output":
        sendToSession(msg.session, {
          type: "output",
          session: msg.session,
          data: msg.data,
        });
        break;

      // Atomic dimension transition + screen reset. Fired by Session
      // after every server-side resize (and by the attach/subscribe
      // paths via the direct return value — this bridge case covers
      // the broadcast to the OTHER clients already subscribed).
      // Clients apply: term.resize(cols, rows) → term.clear() → term.write(data).
      case "snapshot":
        sendToSession(msg.session, {
          type: "snapshot",
          session: msg.session,
          cols: msg.cols,
          rows: msg.rows,
          data: msg.data,
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
        // Broadcast to ALL connected clients, not just those subscribed to
        // this session. Other clients may have a tile/tab pointing at it
        // (e.g., a background carousel card) and need to drop that orphan
        // immediately. Clients that don't recognize the session ignore it.
        // The reconciler in app.js handles the offline case (clients not
        // connected at the moment of removal); this is the live optimization.
        broadcastToAll({ type: "session-removed", session: msg.session });
        break;
      case "session-renamed":
        // Tracker already renamed clients before relay, so route via newName
        sendToSession(msg.newName, { type: "session-renamed", name: msg.newName });
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

      // CLI-driven UI actions
      case "open-tab":
        broadcastToAll({ type: "open-tab", session: msg.session });
        break;
      case "notification":
        broadcastToAll({ type: "notification", title: msg.title, message: msg.message });
        break;

      // Device-to-device auth
      case "device-auth-request":
        broadcastToAll({
          type: "device-auth-request",
          requestId: msg.requestId,
          code: msg.code,
          userAgent: msg.userAgent,
        });
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

  /**
   * Handle a newly-upgraded WebSocket connection.
   *
   * Auth state (`sessionToken`, `credentialId`) is passed in explicitly
   * rather than stashed on the `ws` object. This keeps ws-manager honest
   * about what it reads through the transport abstraction — the underlying
   * socket is used for heartbeat and signaling only, not as a data carrier
   * for application state. `lastAuthCheck` lives in a closure so it can
   * be mutated without touching the transport.
   *
   * @param {import('ws').WebSocket} ws
   * @param {{ sessionToken?: string|null, credentialId?: string|null }} [auth]
   */
  function handleConnection(ws, auth = {}) {
    const clientId = randomUUID();
    const transport = createClientTransport(ws);
    const sessionToken = auth.sessionToken || null;
    const credentialId = auth.credentialId || null;
    let lastAuthCheck = 0;
    log.debug("Client connected", { clientId });

    // Heartbeat: ping every 30s, terminate after 2 missed pongs.
    // Always uses the underlying WebSocket (DataChannel has no ping/pong).
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

    // Messages arrive via the transport (active channel — WS or DataChannel).
    transport.on("message", (raw) => {
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
        transport.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        return;
      }

      if (sessionToken) {
        const now = Date.now();
        const AUTH_RECHECK_MS = 60_000; // Re-validate auth every 60s, not per-message
        if (now - lastAuthCheck >= AUTH_RECHECK_MS) {
          const state = loadState();
          if (!state || !state.isValidLoginToken(sessionToken)) {
            log.warn("WebSocket message rejected: session no longer valid", { clientId, credentialId });
            // Close the underlying WS — signaling channel always closes on auth fail
            transport.ws.close(1008, "Session invalidated");
            cleanupClient(clientId);
            return;
          }
          lastAuthCheck = now;
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
            transport.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client attached", { clientId, session: name });
            // The `attached` message carries the full snapshot: dims
            // + serialized screen. The client applies resize → clear
            // → write atomically before the session enters the wsClients
            // routing table, so the first `output` message it receives
            // is guaranteed to be at the snapshot's dims.
            transport.send(JSON.stringify({
              type: "attached",
              session: name,
              cols: result.cols,
              rows: result.rows,
              data: result.data || "",
            }));
            wsClients.set(clientId, { transport, sessionToken, credentialId });
            if (!result.alive) transport.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
          } catch (err) {
            // Ensure client is routable so cleanupClient can detach the
            // tracker entry on disconnect (attachClient may have succeeded
            // but a transport.send threw due to socket closing mid-sequence).
            if (!wsClients.has(clientId)) {
              wsClients.set(clientId, {
                transport, sessionToken, credentialId,
              });
            }
            log.error("Attach failed", { clientId, error: err.message });
            transport.send(JSON.stringify({ type: "error", message: "Session manager error" }));
          }
        },
        async switch() {
          const name = resolveSessionName(msg.session);
          if (!name) {
            transport.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          const info = wsClients.get(clientId);
          try {
            // Remove from routing during switch so output for the new
            // session doesn't arrive before the switched snapshot does.
            if (info) wsClients.delete(clientId);

            // Re-point the client at the new session — all tmux control
            // mode processes stay attached in the background.
            // Session binding is updated by tracker.attach() inside attachClient.
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client switched", { clientId, session: name });
            // Send the full snapshot so the client's terminal pool entry
            // for this session is reset to authoritative state. Prior
            // Raptor-2 attempts skipped the snapshot to avoid flicker,
            // but that left the client's xterm possibly stale whenever
            // dims or content had changed while it was viewing another
            // tab. Raptor 3 always ships the snapshot because it's the
            // only source of truth.
            transport.send(JSON.stringify({
              type: "switched",
              session: name,
              cols: result.cols,
              rows: result.rows,
              data: result.data || "",
            }));
            wsClients.set(clientId, info || { transport, sessionToken, credentialId });
            if (!result.alive) transport.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
          } catch (err) {
            // Restore routing on failure so the client isn't left unroutable
            if (info && !wsClients.has(clientId)) wsClients.set(clientId, info);
            log.error("Switch failed", { clientId, error: err.message });
            transport.send(JSON.stringify({ type: "error", message: "Session switch error" }));
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
              transport.send(JSON.stringify({ type: "error", message: "No active helm session for this terminal" }));
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
            transport.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            // Raptor 3: subscribe does not change tmux dims — subscribing
            // is a view-only operation (carousel card, background tab).
            // The returned snapshot carries whatever dims the session is
            // currently at; the client applies term.resize → clear → write
            // atomically so its xterm matches server state before any
            // subsequent `output` bytes arrive.
            const result = await sessionManager.subscribeClient(clientId, name);
            log.debug("Client subscribed", { clientId, session: name });
            transport.send(JSON.stringify({
              type: "subscribed",
              session: name,
              cols: result.cols,
              rows: result.rows,
              data: result.data || "",
            }));
            if (!result.alive) {
              transport.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
            }
          } catch (err) {
            log.warn("Subscribe failed", { clientId, session: name, error: err.message });
            // If the session doesn't exist, the client is holding a stale tile
            // (page restored from localStorage after the session was killed
            // elsewhere). Tell it to drop the orphan via the existing
            // session-removed handler instead of surfacing a generic error.
            // The reconciler catches the same case on the next /sessions
            // fetch — this is belt-and-suspenders for the race window.
            if (/not found/i.test(err.message)) {
              transport.send(JSON.stringify({ type: "session-removed", session: name }));
            } else {
              // Generic message — never echo internal err.message back to the
              // client (could leak filesystem paths, internal state, etc.).
              // The full error is already in the server log above.
              transport.send(JSON.stringify({ type: "error", message: "Subscribe failed" }));
            }
          }
        },
        async unsubscribe() {
          const name = resolveSessionName(msg.session);
          if (!name) return;
          sessionManager.unsubscribeClient(clientId, name);
          log.debug("Client unsubscribed", { clientId, session: name });
          transport.send(JSON.stringify({ type: "unsubscribed", session: name }));
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
        // WebRTC signaling — SDP and ICE exchange over WebSocket
        "rtc-offer"() {
          signaling.handleOffer(clientId, { type: "offer", sdp: msg.sdp });
        },
        "rtc-ice-candidate"() {
          signaling.handleCandidate(clientId, msg.candidate);
        },
      };

      const handler = wsMessageHandlers[msg.type] || null;
      if (handler) {
        try {
          await handler();
        } catch (err) {
          log.error("WebSocket handler error", { clientId, type: msg.type, error: err.message });
          if (transport.readyState === 1) {
            transport.send(JSON.stringify({ type: "error", message: "Internal error" }));
          }
        }
      } else if (pluginWsHandlers[msg.type]) {
        try {
          await pluginWsHandlers[msg.type](transport.ws, msg, clientId);
        } catch (err) {
          log.error("Plugin WebSocket handler error", { clientId, type: msg.type, error: err.message });
          if (transport.readyState === 1) {
            transport.send(JSON.stringify({ type: "error", message: "Plugin error" }));
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
