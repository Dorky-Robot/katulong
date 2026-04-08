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

  // Drop output for slow clients to prevent unbounded server memory growth.
  // 1MB threshold — enough for ~20 full terminal screens of buffered output.
  const WS_BACKPRESSURE_BYTES = 1024 * 1024;

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

  function sendToSessionExcluding(sessionName, excludeClientId, payload) {
    const encoded = JSON.stringify(payload);
    for (const [clientId, info] of wsClients) {
      if (!sessionManager.isClientSubscribedTo(clientId, sessionName)) continue;
      if (clientId === excludeClientId) continue;
      if (info.transport.readyState === 1) {
        info.transport.send(encoded);
      }
    }
  }

  // Bridge subscriber — routes session-manager events to WebSocket clients
  bridge.register((msg) => {
    switch (msg.type) {
      // Session I/O routing — push data inline to clients
      case "output": {
        const encoded = JSON.stringify({
          type: "output", session: msg.session,
          data: msg.data, fromSeq: msg.fromSeq, cursor: msg.cursor,
        });
        for (const [clientId, info] of wsClients) {
          if (!sessionManager.isClientSubscribedTo(clientId, msg.session)) continue;
          if (info.transport.readyState !== 1) continue;
          if (info.transport.bufferedAmount > WS_BACKPRESSURE_BYTES) {
            // Backpressure — send lightweight notification so client can pull
            info.transport.send(JSON.stringify({ type: "data-available", session: msg.session }));
          } else {
            info.transport.send(encoded);
          }
        }
        break;
      }
      case "state-check":
        // Drift detection: broadcast a single fingerprint (computed from the
        // shared session headless, which is written live at the current PTY
        // dims) to every client viewing this session. Per-client fingerprints
        // were tried and removed in PCH-7 — replaying RingBuffer history into
        // a differently-sized headless produces drift, not correctness (see
        // the "Multi-device terminal dimensions" note in CLAUDE.md).
        // Forward `seq` alongside `fingerprint` so clients can defer the
        // drift compare until their pull cursor catches up to the byte
        // position the server sampled. Without `seq`, Bug #5's Lamport
        // fix (session-manager emits {fingerprint, seq}; client compares
        // only at matching seq) is a no-op end-to-end.
        sendToSession(msg.session, {
          type: "state-check",
          session: msg.session,
          fingerprint: msg.fingerprint,
          seq: msg.seq,
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

  function handleConnection(ws) {
    const clientId = randomUUID();
    const transport = createClientTransport(ws);
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

      if (transport.ws.sessionToken) {
        const now = Date.now();
        const AUTH_RECHECK_MS = 60_000; // Re-validate auth every 60s, not per-message
        if (!transport.ws._lastAuthCheck || now - transport.ws._lastAuthCheck >= AUTH_RECHECK_MS) {
          const state = loadState();
          if (!state || !state.isValidLoginToken(transport.ws.sessionToken)) {
            log.warn("WebSocket message rejected: session no longer valid", { clientId, credentialId: transport.ws.credentialId });
            transport.ws.close(1008, "Session invalidated");
            cleanupClient(clientId);
            return;
          }
          transport.ws._lastAuthCheck = now;
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
            transport.send(JSON.stringify({ type: "attached", session: name, data: result.buffer || "" }));
            if (result.seq !== undefined) {
              transport.send(JSON.stringify({ type: "seq-init", session: name, seq: result.seq }));
            }
            // Register in routing table AFTER seq-init so data-available
            // notifications don't arrive before the client's pull state is
            // initialized.  Any output in the gap is recovered on first pull.
            wsClients.set(clientId, {
              transport, sessionToken: transport.ws.sessionToken,
              credentialId: transport.ws.credentialId,
            });
            // Nudge the client to pull — covers data that arrived during
            // the async attach before the client was in the routing table.
            transport.send(JSON.stringify({ type: "data-available", session: name }));
            if (!result.alive) transport.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
          } catch (err) {
            // Ensure client is routable so cleanupClient can detach the
            // tracker entry on disconnect (attachClient may have succeeded
            // but a transport.send threw due to socket closing mid-sequence).
            if (!wsClients.has(clientId)) {
              wsClients.set(clientId, {
                transport, sessionToken: transport.ws.sessionToken,
                credentialId: transport.ws.credentialId,
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
          // Hoist outside try so it's visible in the catch block for restore
          const info = wsClients.get(clientId);
          try {
            // Remove from routing during switch to prevent data-available
            // notifications for the new session arriving before seq-init.
            if (info) wsClients.delete(clientId);

            // Re-point the client at the new session — all tmux control
            // mode processes stay attached in the background.
            // Session binding is updated by tracker.attach() inside attachClient.
            const result = await sessionManager.attachClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client switched", { clientId, session: name });
            // No snapshot data — client's terminal pool already has the content.
            // Just send seq-init so the pull mechanism resumes from current head.
            transport.send(JSON.stringify({ type: "switched", session: name }));
            if (result.seq !== undefined) {
              transport.send(JSON.stringify({ type: "seq-init", session: name, seq: result.seq }));
            }
            // Re-add to routing AFTER seq-init — any output in the gap
            // is recovered on first pull.
            wsClients.set(clientId, info || {
              transport, sessionToken: transport.ws.sessionToken,
              credentialId: transport.ws.credentialId,
            });
            // Nudge the client to pull immediately — data-available
            // notifications during the routing gap were lost.
            transport.send(JSON.stringify({ type: "data-available", session: name }));

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
        async pull() {
          // Client-driven pull: return all data from fromSeq to head.
          // If the cursor has been evicted, send a pane snapshot so the
          // client can recover without a full reconnect.
          const name = msg.session ? resolveSessionName(msg.session) : sessionManager.getSessionForClient(clientId);
          if (!name || !sessionManager.isClientSubscribedTo(clientId, name)) return;
          const session = sessionManager.getSession(name);
          if (!session) return;
          if (transport.bufferedAmount > WS_BACKPRESSURE_BYTES) {
            // Send empty response so client's pull manager unsticks immediately
            // instead of waiting for the 2s safety timeout.
            transport.send(JSON.stringify({
              type: "pull-response",
              session: name,
              data: "",
              cursor: session.outputBuffer.totalBytes,
            }));
            return;
          }
          const data = session.outputBuffer.sliceFrom(msg.fromSeq);
          if (data === null) {
            // Cursor evicted — use the shared session headless for recovery
            // snapshot. The shared headless is written live at the current
            // PTY dims so it never drifts; per-client replay was removed in
            // PCH-7 because it could not correctly re-interpret absolute
            // cursor escapes recorded at a different size.
            const snapshot = (await session.serializeScreen()) || "";
            transport.send(JSON.stringify({
              type: "pull-snapshot",
              session: name,
              data: snapshot,
              cursor: session.outputBuffer.totalBytes,
            }));
          } else {
            transport.send(JSON.stringify({
              type: "pull-response",
              session: name,
              data,
              cursor: session.outputBuffer.totalBytes,
            }));
          }
        },
        async resync() {
          // Drift detected by client — serialize from the shared session
          // headless. The shared headless is written live at current PTY
          // dims and reflowed on resize, so it always reflects truth.
          const name = msg.session ? resolveSessionName(msg.session) : sessionManager.getSessionForClient(clientId);
          if (!name || !sessionManager.isClientSubscribedTo(clientId, name)) return;
          const session = sessionManager.getSession(name);
          if (!session?.alive) return;
          const snapshot = (await session.serializeScreen()) || "";
          const cursor = session.outputBuffer.totalBytes;
          log.debug("Resync requested", { clientId, session: name });
          transport.send(JSON.stringify({
            type: "pull-snapshot",
            session: name,
            data: snapshot,
            cursor,
          }));
        },
        async subscribe() {
          const name = resolveSessionName(msg.session);
          if (!name) {
            transport.send(JSON.stringify({ type: "error", message: "Invalid session name" }));
            return;
          }
          try {
            const result = await sessionManager.subscribeClient(clientId, name, msg.cols, msg.rows);
            log.debug("Client subscribed", { clientId, session: name });
            transport.send(JSON.stringify({ type: "subscribed", session: name, data: result.buffer || "" }));
            // Only send seq-init on FIRST subscribe — re-subscribes (carousel
            // swipe) must not reset the pull cursor or in-flight pulls are lost.
            if (result.isNew && result.seq !== undefined) {
              transport.send(JSON.stringify({ type: "seq-init", session: name, seq: result.seq }));
              // Nudge pull immediately after first subscribe
              transport.send(JSON.stringify({ type: "data-available", session: name }));
            }
            if (!result.alive) {
              transport.send(JSON.stringify({ type: "exit", session: name, code: -1 }));
            }
          } catch (err) {
            log.warn("Subscribe failed", { clientId, session: name, error: err.message });
            transport.send(JSON.stringify({ type: "error", message: err.message }));
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
