/**
 * Tests for WebSocket subscribe flow (carousel tile output)
 *
 * websocket-connection.js uses browser-absolute imports (/lib/...) that
 * can't be resolved in Node. We test the subscribe logic by extracting
 * and verifying the message handler contracts and effect behavior.
 *
 * Verifies that:
 * - subscribed message produces a terminal reset effect for the session
 * - subscribe → output → seq-init flow produces correct terminal state
 * - duplicate subscribes are suppressed (sendSubscribe dedup)
 * - disconnect clears subscription tracking
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Reimplementation of subscribe-relevant behavior for testing ---
// Mirrors the real createWebSocketConnection subscribe logic.

function createSubscribeTestHarness() {
  const terminals = new Map();
  const pullStates = new Map();
  const subscribedSessions = new Set();
  const sent = [];
  let ws = null;

  function getOutputTerm(session) {
    return terminals.get(session) || null;
  }

  function terminalWriteWithScroll(term, data, cb) {
    term._written = (term._written || "") + data;
    if (cb) cb();
  }

  // Message handlers (mirrors websocket-connection.js)
  const handlers = {
    subscribed: (msg) => ({
      stateUpdates: {},
      effects: [
        { type: "terminalResetSession", session: msg.session },
      ],
    }),

    output: (msg) => ({
      stateUpdates: {},
      effects: [
        { type: "terminalWrite", data: msg.data, session: msg.session, useOutputTerm: true },
      ],
    }),

    "seq-init": (msg) => ({
      stateUpdates: {},
      effects: [
        { type: "pullInit", session: msg.session, seq: msg.seq },
      ],
    }),
  };

  function executeEffect(effect) {
    switch (effect.type) {
      case "terminalResetSession": {
        const term = getOutputTerm(effect.session);
        if (!term) break;
        term.clear();
        term.reset();
        break;
      }
      case "terminalWrite": {
        const term = effect.useOutputTerm ? getOutputTerm(effect.session) : null;
        if (!term) break;
        terminalWriteWithScroll(term, effect.data);
        break;
      }
      case "pullInit": {
        if (!effect.session) break;
        pullStates.set(effect.session, {
          cursor: effect.seq,
          pulling: false,
          writing: false,
          pending: false,
        });
        // Would call sendPull here in real code
        if (ws) {
          sent.push({ type: "pull", session: effect.session, fromSeq: effect.seq });
        }
        break;
      }
    }
  }

  function processMessage(type, msg) {
    const handler = handlers[type];
    if (!handler) return;
    const { effects } = handler(msg);
    effects.forEach(executeEffect);
  }

  function sendSubscribe(sessionName) {
    if (ws && !subscribedSessions.has(sessionName)) {
      subscribedSessions.add(sessionName);
      sent.push({ type: "subscribe", session: sessionName });
    }
  }

  function sendUnsubscribe(sessionName) {
    subscribedSessions.delete(sessionName);
    if (ws) {
      sent.push({ type: "unsubscribe", session: sessionName });
    }
  }

  function disconnect() {
    subscribedSessions.clear();
    pullStates.clear();
    ws = null;
  }

  function connect() {
    ws = true;
    sent.length = 0;
  }

  return {
    terminals,
    pullStates,
    subscribedSessions,
    sent,
    handlers,
    executeEffect,
    processMessage,
    sendSubscribe,
    sendUnsubscribe,
    disconnect,
    connect,
  };
}

function createMockTerminal(content = "") {
  return {
    cols: 80,
    rows: 24,
    _written: content,
    _cleared: false,
    _reset: false,
    clear() { this._cleared = true; this._written = ""; },
    reset() { this._reset = true; },
  };
}

// --- Tests ---

describe("WebSocket subscribe flow", () => {
  let h;

  beforeEach(() => {
    h = createSubscribeTestHarness();
    h.connect();
  });

  describe("subscribed message handler", () => {
    it("produces terminalResetSession effect for the subscribed session", () => {
      const { effects } = h.handlers.subscribed({ session: "bg" });
      const resetEffect = effects.find((e) => e.type === "terminalResetSession");
      assert.ok(resetEffect, "should have terminalResetSession effect");
      assert.equal(resetEffect.session, "bg");
    });
  });

  describe("terminalResetSession effect", () => {
    it("clears and resets the specific session terminal", () => {
      const term = createMockTerminal("stale content");
      h.terminals.set("bg", term);

      h.executeEffect({ type: "terminalResetSession", session: "bg" });

      assert.equal(term._cleared, true);
      assert.equal(term._reset, true);
      assert.equal(term._written, "");
    });

    it("does not affect other terminals", () => {
      const mainTerm = createMockTerminal("main content");
      h.terminals.set("main", mainTerm);

      const bgTerm = createMockTerminal();
      h.terminals.set("bg", bgTerm);

      h.executeEffect({ type: "terminalResetSession", session: "bg" });

      assert.equal(mainTerm._written, "main content", "main terminal untouched");
      assert.equal(mainTerm._cleared, false);
    });

    it("is a no-op if terminal does not exist", () => {
      // Should not throw
      h.executeEffect({ type: "terminalResetSession", session: "nonexistent" });
    });
  });

  describe("subscribe → output → seq-init flow", () => {
    it("reset + snapshot produces correct terminal content", () => {
      const term = createMockTerminal("old stale data");
      h.terminals.set("bg", term);

      // Step 1: subscribed resets terminal
      h.processMessage("subscribed", { session: "bg" });
      assert.equal(term._written, "", "terminal cleared after subscribed");

      // Step 2: output writes snapshot
      h.processMessage("output", { session: "bg", data: "$ prompt> " });
      assert.equal(term._written, "$ prompt> ", "snapshot written to terminal");
    });

    it("full flow initializes pull state and sends first pull", () => {
      const term = createMockTerminal();
      h.terminals.set("bg", term);

      h.processMessage("subscribed", { session: "bg" });
      h.processMessage("output", { session: "bg", data: "snapshot data" });
      h.processMessage("seq-init", { session: "bg", seq: 500 });

      // Pull state should be initialized
      const ps = h.pullStates.get("bg");
      assert.ok(ps, "pull state should exist");
      assert.equal(ps.cursor, 500);

      // Should have sent a pull
      const pullMsg = h.sent.find((m) => m.type === "pull" && m.session === "bg");
      assert.ok(pullMsg, "should send initial pull after seq-init");
      assert.equal(pullMsg.fromSeq, 500);
    });

    it("works for multiple background sessions simultaneously", () => {
      const termA = createMockTerminal();
      const termB = createMockTerminal();
      h.terminals.set("a", termA);
      h.terminals.set("b", termB);

      h.processMessage("subscribed", { session: "a" });
      h.processMessage("subscribed", { session: "b" });
      h.processMessage("output", { session: "a", data: "output-a" });
      h.processMessage("output", { session: "b", data: "output-b" });

      assert.equal(termA._written, "output-a");
      assert.equal(termB._written, "output-b");
    });

    it("re-subscribe clears stale content before new snapshot", () => {
      const term = createMockTerminal();
      h.terminals.set("bg", term);

      // First subscribe cycle
      h.processMessage("subscribed", { session: "bg" });
      h.processMessage("output", { session: "bg", data: "first snapshot" });
      assert.equal(term._written, "first snapshot");

      // Second subscribe (e.g., after reconnect)
      h.processMessage("subscribed", { session: "bg" });
      assert.equal(term._written, "", "stale content cleared");

      h.processMessage("output", { session: "bg", data: "fresh snapshot" });
      assert.equal(term._written, "fresh snapshot");
    });
  });

  describe("sendSubscribe deduplication", () => {
    it("sends subscribe only once per session", () => {
      h.sendSubscribe("bg");
      h.sendSubscribe("bg");
      h.sendSubscribe("bg");

      const msgs = h.sent.filter((m) => m.type === "subscribe");
      assert.equal(msgs.length, 1, "should only send one subscribe");
    });

    it("allows re-subscribe after unsubscribe", () => {
      h.sendSubscribe("bg");
      h.sendUnsubscribe("bg");
      h.sendSubscribe("bg");

      const msgs = h.sent.filter((m) => m.type === "subscribe");
      assert.equal(msgs.length, 2, "should allow re-subscribe after unsubscribe");
    });

    it("allows re-subscribe after disconnect", () => {
      h.sendSubscribe("bg");
      h.disconnect();
      h.connect();
      h.sendSubscribe("bg");

      const msgs = h.sent.filter((m) => m.type === "subscribe");
      assert.equal(msgs.length, 1, "should re-subscribe after disconnect (sent was reset)");
      assert.equal(h.subscribedSessions.has("bg"), true);
    });

    it("different sessions are tracked independently", () => {
      h.sendSubscribe("a");
      h.sendSubscribe("b");
      h.sendSubscribe("a"); // duplicate

      const msgs = h.sent.filter((m) => m.type === "subscribe");
      assert.equal(msgs.length, 2, "should send subscribe for a and b only");
    });
  });

  describe("output without existing terminal", () => {
    it("silently drops output when terminal does not exist", () => {
      // No terminal in pool — should not throw
      h.processMessage("subscribed", { session: "ghost" });
      h.processMessage("output", { session: "ghost", data: "lost data" });
      // No assertion needed — just shouldn't throw
    });
  });
});
