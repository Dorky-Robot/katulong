/**
 * Claude Session Manager
 *
 * Manages claude code sessions initiated by yolo processes running inside
 * terminal sessions. Each yolo process connects via a dedicated WebSocket
 * at /ws/claude and streams Agent SDK events. These events are relayed
 * through the transport bridge to browser clients viewing the corresponding
 * terminal session.
 *
 * Protocol (yolo → katulong):
 *   claude:start            — register session { session, prompt, cwd }
 *   claude:event            — Agent SDK event { session, event }
 *   claude:turn-complete    — agent finished, waiting for input { session }
 *   claude:waiting-for-input — ready for user message { session }
 *   claude:end              — session ended { session, result, error? }
 *
 * Protocol (katulong → yolo):
 *   claude:registered       — session acknowledged
 *   claude:user-message     — user sent follow-up { content }
 *   claude:tool-response    — user approved/denied tool { id, approved }
 *   claude:abort            — user cancelled
 *   error                   — error message { message }
 *
 * Protocol (katulong → browser, via bridge):
 *   claude-mode-changed     — terminal session entered/exited claude mode
 *   claude-event            — relayed Agent SDK event
 *   claude-turn-complete    — agent waiting for input
 *   claude-waiting-for-input
 */

import { log } from "./log.js";

/**
 * Create a claude session manager.
 *
 * @param {object} opts
 * @param {object} opts.bridge - Transport bridge for relaying events to browser
 * @returns {object} Manager API
 */
export function createClaudeSessionManager({ bridge }) {
  // terminalSession → { ws, prompt, cwd, active }
  const claudeSessions = new Map();

  /**
   * Handle a new WebSocket connection from a yolo process.
   */
  function handleConnection(ws) {
    let boundSession = null;

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case "claude:start":
          boundSession = handleStart(ws, msg);
          break;
        case "claude:event":
          handleEvent(msg);
          break;
        case "claude:turn-complete":
          handleTurnComplete(msg);
          break;
        case "claude:waiting-for-input":
          handleWaitingForInput(msg);
          break;
        case "claude:end":
          handleEnd(msg);
          break;
        default:
          log.debug("Unknown claude message type", { type: msg.type });
      }
    });

    ws.on("close", () => {
      if (boundSession) {
        handleEnd({ session: boundSession, result: "disconnected" });
      }
    });

    ws.on("error", (err) => {
      log.warn("Claude WebSocket error", { error: err.message });
      if (boundSession) {
        handleEnd({ session: boundSession, result: "error", error: err.message });
      }
    });
  }

  function handleStart(ws, msg) {
    const { session, prompt, cwd } = msg;
    if (!session || typeof session !== "string") {
      ws.send(JSON.stringify({ type: "error", message: "Missing session name" }));
      return null;
    }

    // If there's already an active claude session for this terminal, reject
    if (claudeSessions.has(session)) {
      ws.send(JSON.stringify({ type: "error", message: "Claude session already active for this terminal" }));
      return null;
    }

    claudeSessions.set(session, { ws, prompt, cwd, active: true });
    log.info("Claude session started", { session, prompt: prompt?.slice(0, 80) });

    // Acknowledge
    ws.send(JSON.stringify({ type: "claude:registered" }));

    // Notify browser clients
    bridge.relay({
      type: "claude-mode-changed",
      session,
      active: true,
      prompt: prompt || null,
      cwd: cwd || null,
    });

    return session;
  }

  function handleEvent(msg) {
    const { session, event } = msg;
    if (!session || !claudeSessions.has(session)) return;

    bridge.relay({
      type: "claude-event",
      session,
      event,
    });
  }

  function handleTurnComplete(msg) {
    const { session } = msg;
    if (!session || !claudeSessions.has(session)) return;

    bridge.relay({
      type: "claude-turn-complete",
      session,
    });
  }

  function handleWaitingForInput(msg) {
    const { session } = msg;
    if (!session || !claudeSessions.has(session)) return;

    bridge.relay({
      type: "claude-waiting-for-input",
      session,
    });
  }

  function handleEnd(msg) {
    const { session, result, error } = msg;
    if (!session) return;

    const entry = claudeSessions.get(session);
    if (!entry) return;

    claudeSessions.delete(session);
    log.info("Claude session ended", { session, result, error });

    bridge.relay({
      type: "claude-mode-changed",
      session,
      active: false,
      result: result || "ended",
      error: error || null,
    });
  }

  return {
    handleConnection,

    /**
     * Send a user message from the browser to the yolo process.
     * @param {string} session - terminal session name
     * @param {string} content - user message
     * @returns {boolean} true if delivered
     */
    sendUserMessage(session, content) {
      const entry = claudeSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({
        type: "claude:user-message",
        content,
      }));
      return true;
    },

    /**
     * Send a tool approval response from the browser to yolo.
     * @param {string} session
     * @param {string} toolCallId
     * @param {boolean} approved
     * @returns {boolean}
     */
    sendToolResponse(session, toolCallId, approved) {
      const entry = claudeSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({
        type: "claude:tool-response",
        id: toolCallId,
        approved,
      }));
      return true;
    },

    /**
     * Abort a claude session from the browser.
     * @param {string} session
     * @returns {boolean}
     */
    abortSession(session) {
      const entry = claudeSessions.get(session);
      if (!entry || entry.ws.readyState !== 1) return false;

      entry.ws.send(JSON.stringify({ type: "claude:abort" }));
      return true;
    },

    /**
     * Check if a terminal session has an active claude session.
     * @param {string} session
     * @returns {boolean}
     */
    isActive(session) {
      return claudeSessions.has(session);
    },

    /**
     * Get all active claude sessions.
     * @returns {object[]}
     */
    listSessions() {
      return [...claudeSessions.entries()].map(([session, entry]) => ({
        session,
        prompt: entry.prompt,
        cwd: entry.cwd,
        active: entry.active,
      }));
    },

    /**
     * Shutdown — close all yolo WebSocket connections.
     */
    shutdown() {
      for (const [session, entry] of claudeSessions) {
        try {
          entry.ws.send(JSON.stringify({ type: "claude:abort" }));
          entry.ws.close();
        } catch { /* already closed */ }
      }
      claudeSessions.clear();
    },
  };
}
