/**
 * Helm Session Manager
 *
 * Manages helm mode sessions — agentic interactions where a connecting
 * process (the "agent client") streams structured conversation events
 * to browser clients viewing a terminal session, instead of rendering
 * a TUI in xterm.js.
 *
 * Helm mode is agent-agnostic. Any process can connect via /ws/helm,
 * declare its agent identity, and start streaming events. The protocol
 * carries opaque event payloads — katulong doesn't interpret them,
 * just relays them to the browser for rendering.
 *
 * Protocol (agent client → katulong):
 *   helm:start            — register { session, agent, prompt?, cwd? }
 *   helm:event            — agent event { session, event }
 *   helm:turn-complete    — agent finished turn, waiting for input { session }
 *   helm:waiting-for-input — ready for user message { session }
 *   helm:end              — session ended { session, result, error? }
 *
 * Protocol (katulong → agent client):
 *   helm:registered       — session acknowledged { session }
 *   helm:user-message     — user sent follow-up { content }
 *   helm:tool-response    — user approved/denied tool { id, approved }
 *   helm:abort            — user cancelled
 *   error                 — error message { message }
 *
 * Protocol (katulong → browser, via bridge):
 *   helm-mode-changed     — session entered/exited helm mode
 *   helm-event            — relayed agent event
 *   helm-turn-complete    — agent waiting for input
 *   helm-waiting-for-input
 */

import { log } from "./log.js";

/**
 * Create a helm session manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge for relaying events to browser
 * @returns {object} Manager API
 */
export function createHelmSessionManager({ bridge }) {
  // terminalSession → { ws, agent, prompt, cwd, active }
  const helmSessions = new Map();

  /**
   * Handle a new WebSocket connection from an agent client.
   */
  function handleConnection(ws) {
    let boundSession = null;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case "helm:start":
          boundSession = handleStart(ws, msg);
          break;
        case "helm:event":
          handleEvent(msg);
          break;
        case "helm:turn-complete":
          handleTurnComplete(msg);
          break;
        case "helm:waiting-for-input":
          handleWaitingForInput(msg);
          break;
        case "helm:end":
          handleEnd(msg);
          break;
        default:
          log.debug("Unknown helm message type", { type: msg.type });
      }
    });

    ws.on("close", () => {
      if (boundSession) {
        handleEnd({ session: boundSession, result: "disconnected" });
      }
    });

    ws.on("error", (err) => {
      log.warn("Helm WebSocket error", { error: err.message });
      if (boundSession) {
        handleEnd({ session: boundSession, result: "error", error: err.message });
      }
    });
  }

  function handleStart(ws, msg) {
    const { session, agent, prompt, cwd } = msg;
    if (!session || typeof session !== "string") {
      ws.send(JSON.stringify({ type: "error", message: "Missing session name" }));
      return null;
    }

    if (!agent || typeof agent !== "string") {
      ws.send(JSON.stringify({ type: "error", message: "Missing agent identity" }));
      return null;
    }

    // If there's already an active helm session for this terminal, reject
    if (helmSessions.has(session)) {
      ws.send(JSON.stringify({ type: "error", message: "Helm session already active for this terminal" }));
      return null;
    }

    helmSessions.set(session, { ws, agent, prompt, cwd, active: true });
    log.info("Helm session started", { session, agent, prompt: prompt?.slice(0, 80) });

    // Acknowledge
    ws.send(JSON.stringify({ type: "helm:registered", session }));

    // Notify browser clients
    bridge.relay({
      type: "helm-mode-changed",
      session,
      active: true,
      agent,
      prompt: prompt || null,
      cwd: cwd || null,
    });

    return session;
  }

  function handleEvent(msg) {
    const { session, event } = msg;
    if (!session || !helmSessions.has(session)) return;

    bridge.relay({
      type: "helm-event",
      session,
      event,
    });
  }

  function handleTurnComplete(msg) {
    const { session } = msg;
    if (!session || !helmSessions.has(session)) return;

    bridge.relay({
      type: "helm-turn-complete",
      session,
    });
  }

  function handleWaitingForInput(msg) {
    const { session } = msg;
    if (!session || !helmSessions.has(session)) return;

    bridge.relay({
      type: "helm-waiting-for-input",
      session,
    });
  }

  function handleEnd(msg) {
    const { session, result, error } = msg;
    if (!session) return;

    const entry = helmSessions.get(session);
    if (!entry) return;

    helmSessions.delete(session);
    log.info("Helm session ended", { session, agent: entry.agent, result, error });

    bridge.relay({
      type: "helm-mode-changed",
      session,
      active: false,
      agent: entry.agent,
      result: result || "ended",
      error: error || null,
    });
  }

  return {
    handleConnection,

    /**
     * Send a user message from the browser to the agent client.
     * @param {string} session - terminal session name
     * @param {string} content - user message
     * @returns {boolean} true if delivered
     */
    sendUserMessage(session, content) {
      const entry = helmSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({
        type: "helm:user-message",
        content,
      }));
      return true;
    },

    /**
     * Send a tool approval response from the browser to the agent client.
     * @param {string} session
     * @param {string} toolCallId
     * @param {boolean} approved
     * @returns {boolean}
     */
    sendToolResponse(session, toolCallId, approved) {
      const entry = helmSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({
        type: "helm:tool-response",
        id: toolCallId,
        approved,
      }));
      return true;
    },

    /**
     * Abort a helm session from the browser.
     * @param {string} session
     * @returns {boolean}
     */
    abortSession(session) {
      const entry = helmSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({ type: "helm:abort" }));
      return true;
    },

    /**
     * Check if a terminal session has an active helm session.
     * @param {string} session
     * @returns {boolean}
     */
    isActive(session) {
      return helmSessions.has(session);
    },

    /**
     * Get all active helm sessions.
     * @returns {object[]}
     */
    listSessions() {
      return [...helmSessions.entries()].map(([session, entry]) => ({
        session,
        agent: entry.agent,
        prompt: entry.prompt,
        cwd: entry.cwd,
        active: entry.active,
      }));
    },

    /**
     * Shutdown — close all agent client WebSocket connections.
     */
    shutdown() {
      for (const [, entry] of helmSessions) {
        try {
          entry.ws.send(JSON.stringify({ type: "helm:abort" }));
          entry.ws.close();
        } catch { /* already closed */ }
      }
      helmSessions.clear();
    },
  };
}
