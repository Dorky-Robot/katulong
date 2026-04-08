/**
 * Tests for the output coalescer in lib/session-manager.js.
 *
 * Why this exists as a dedicated test file:
 * The 2ms idle / 16ms hard-cap debounce is the seam where "tmux %output
 * lines" become "WebSocket frames the client renders." Every garbled-frame
 * symptom we have ever shipped trace-back went through this code:
 *   - Tier 1.1: lifecycle events cancelled the timers without flushing
 *   - PR #515: per-client headlesses raced the coalesce window
 *   - PR #483: SIGWINCH storms while bytes were queued
 * The coalescer was previously only tested *indirectly* via attach/subscribe
 * regression tests. This file pins its timing contract directly so future
 * changes (different debounce constants, different scheduling, different
 * batching) cannot silently regress the frame-delivery guarantee.
 *
 * Contract under test (Raptor 3):
 *   1. A single %output burst is delivered after the idle timer fires
 *      (one merged frame, not N micro-messages).
 *   2. Continuous output is force-flushed at the hard cap so a never-
 *      idle stream cannot starve clients.
 *   3. The flush carries the concatenated payload directly — Raptor 3
 *      removed the fromSeq/cursor cursor protocol, so the bridge message
 *      is just `{type: "output", session, data}`.
 *   4. Multiple sessions coalesce independently — one busy session must not
 *      block another from being delivered.
 *   5. Lifecycle events flush rather than cancel (Tier 1.1 regression).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  setupSessionManagerMocks,
  BaseMockSession,
  makeBridge,
  tmuxSessions,
} from "./helpers/session-manager-fixture.js";

/**
 * MockSession with a feed() helper that simulates an incoming %output
 * burst exactly the way the real Session does under Raptor 3: call
 * onData with the concatenated payload (no fromSeq, no RingBuffer).
 */
class MockSession extends BaseMockSession {
  feed(bytes) {
    // Raptor 3: session.onData(name, payload) is the single data signal.
    // The session-manager wires this to outputCoalescer.push(name, payload).
    this._options.onData(this.name, bytes);
  }
}

const { createSessionManager } = await setupSessionManagerMocks(MockSession);

function makeManager() {
  const bridge = makeBridge();
  const mgr = createSessionManager({ bridge, shell: "/bin/sh", home: "/tmp" });
  return { mgr, bridge };
}

/**
 * Wait for `predicate` to return truthy or for `maxMs` to elapse, polling
 * every 1ms. Used instead of fixed sleeps so tests are not flakier than
 * the timing contract they pin.
 */
async function waitFor(predicate, maxMs = 200) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 1));
  }
  return false;
}

describe("output coalescer (garble regression)", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  it("merges a burst of %output lines into a single bridge message", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "burst", 80, 24);
    const session = mgr.getSession("burst");
    bridge.messages.length = 0;

    // Three %output lines arriving back-to-back within the idle window
    // must produce ONE bridge "output" message, not three.
    session.feed("line1\r\n");
    session.feed("line2\r\n");
    session.feed("line3\r\n");

    await waitFor(() => bridge.messages.some(m => m.type === "output" && m.session === "burst"));

    const outputs = bridge.messages.filter(m => m.type === "output" && m.session === "burst");
    assert.strictEqual(outputs.length, 1,
      "the idle debounce must merge a burst into a single bridge relay");
    assert.strictEqual(outputs[0].data, "line1\r\nline2\r\nline3\r\n",
      "merged frame must contain every byte from the burst");
  });

  it("force-flushes at the hard cap when output never goes idle", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "stream", 80, 24);
    const session = mgr.getSession("stream");
    bridge.messages.length = 0;

    // Hammer the coalescer every 1ms — the idle timer keeps resetting,
    // so the only way bytes ever reach the bridge is via the hard cap.
    // Without the cap, the test would time out and the assertion would fail.
    let stop = false;
    const timer = setInterval(() => {
      if (stop) return;
      session.feed("x");
    }, 1);

    const flushed = await waitFor(
      () => bridge.messages.some(m => m.type === "output" && m.session === "stream"),
      200, // give the cap several chances to fire
    );
    stop = true;
    clearInterval(timer);

    assert.ok(flushed,
      "hard cap must force-flush a never-idle stream — otherwise " +
      "TUI redraws (htop, tail -f) starve clients indefinitely");

    const out = bridge.messages.find(m => m.type === "output" && m.session === "stream");
    assert.ok(out.data.length > 0, "cap-flush must carry actual buffered data");
  });

  it("coalesces sessions independently — one burst does not block others", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("a", "alpha", 80, 24);
    await mgr.attachClient("b", "beta", 80, 24);
    const a = mgr.getSession("alpha");
    const b = mgr.getSession("beta");
    bridge.messages.length = 0;

    a.feed("from-alpha");
    b.feed("from-beta");

    await waitFor(() =>
      bridge.messages.some(m => m.type === "output" && m.session === "alpha") &&
      bridge.messages.some(m => m.type === "output" && m.session === "beta")
    );

    const alphaOut = bridge.messages.find(m => m.type === "output" && m.session === "alpha");
    const betaOut = bridge.messages.find(m => m.type === "output" && m.session === "beta");
    assert.ok(alphaOut, "alpha must flush independently");
    assert.ok(betaOut, "beta must flush independently");
    assert.strictEqual(alphaOut.data, "from-alpha");
    assert.strictEqual(betaOut.data, "from-beta");
  });

  it("a delete during the coalesce window flushes pending bytes (Tier 1.1 regression)", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "doomed", 80, 24);
    const session = mgr.getSession("doomed");
    bridge.messages.length = 0;

    // Plant bytes in the coalescer, THEN delete the session before the
    // idle timer fires. The pre-Tier-1.1 code called cancelNotification
    // which dropped these bytes on the floor — already-subscribed clients
    // saw the screen freeze mid-frame.
    session.feed("about-to-be-deleted");
    mgr.deleteSession("doomed");

    const out = bridge.messages.find(m => m.type === "output" && m.session === "doomed");
    assert.ok(out, "deleteSession must flush queued bytes before removing the session");
    assert.strictEqual(out.data, "about-to-be-deleted");
  });
});
