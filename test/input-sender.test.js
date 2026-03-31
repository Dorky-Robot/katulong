/**
 * Tests for input-sender.js
 *
 * Verifies that the buffered input sender correctly batches data and
 * only sends when the WebSocket is open (readyState === 1).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createInputSender } from "../public/lib/input-sender.js";

// Simulate requestAnimationFrame synchronously for testing
let rafCallbacks = [];
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

function installSyncRAF() {
  let nextId = 1;
  rafCallbacks = [];
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++;
    rafCallbacks.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafCallbacks = rafCallbacks.filter(r => r.id !== id);
  };
}

function flushRAF() {
  const cbs = rafCallbacks.splice(0);
  cbs.forEach(r => r.cb());
}

function restoreRAF() {
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
}

describe("createInputSender", () => {
  beforeEach(() => installSyncRAF());

  it("sends buffered data when WebSocket is open", () => {
    const sent = [];
    const sender = createInputSender({
      getWebSocket: () => ({ readyState: 1, send: (d) => sent.push(d) }),
      getSession: () => "test-session",
      onInput: () => {},
    });

    sender.send("he");
    sender.send("llo");
    assert.strictEqual(sent.length, 0, "should not send before RAF flush");

    flushRAF();
    assert.strictEqual(sent.length, 1);
    const payload = JSON.parse(sent[0]);
    assert.strictEqual(payload.type, "input");
    assert.strictEqual(payload.data, "hello");
    assert.strictEqual(payload.session, "test-session");
    restoreRAF();
  });

  it("drops data silently when WebSocket is not open", () => {
    const sent = [];
    const sender = createInputSender({
      getWebSocket: () => ({ readyState: 3, send: (d) => sent.push(d) }),
      getSession: () => "s",
      onInput: () => {},
    });

    sender.send("dropped");
    flushRAF();
    assert.strictEqual(sent.length, 0, "should not send when WS is closed");
    restoreRAF();
  });

  it("drops data when WebSocket is null", () => {
    const sender = createInputSender({
      getWebSocket: () => null,
      getSession: () => "s",
      onInput: () => {},
    });

    sender.send("dropped");
    flushRAF();
    // No assertion needed beyond "no crash"
    restoreRAF();
  });

  it("clears buffer and cancels pending RAF on clear()", () => {
    const sent = [];
    const sender = createInputSender({
      getWebSocket: () => ({ readyState: 1, send: (d) => sent.push(d) }),
      getSession: () => "s",
      onInput: () => {},
    });

    sender.send("will-be-cleared");
    sender.clear();
    flushRAF();
    assert.strictEqual(sent.length, 0, "should not send after clear()");
    assert.strictEqual(sender.getBuffer(), "");
    restoreRAF();
  });
});
