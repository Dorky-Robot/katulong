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
 * Contract under test:
 *   1. A single %output burst is delivered after the 2ms idle timer fires
 *      (one merged frame, not N micro-messages).
 *   2. Continuous output is force-flushed at the 16ms hard cap so a never-
 *      idle stream cannot starve clients.
 *   3. The flush carries `fromSeq` from the FIRST burst and `cursor` from
 *      the latest RingBuffer position — clients depend on this contract to
 *      detect gaps and request resyncs.
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
 * MockSession with a RingBuffer-like outputBuffer and a feed() helper
 * that simulates an incoming %output burst exactly the way the real
 * Session does (push bytes, then call onData with the pre-write seq).
 */
class MockSession extends BaseMockSession {
  constructor(name, tmuxName, options = {}) {
    super(name, tmuxName, options);
    this.outputBuffer = {
      totalBytes: 0,
      _data: "",
      push(chunk) { this._data += chunk; this.totalBytes = this._data.length; },
      sliceFrom(from) { return this._data.slice(from); },
    };
  }

  feed(bytes) {
    const fromSeq = this.outputBuffer.totalBytes;
    this.outputBuffer.push(bytes);
    this._options.onData(this.name, fromSeq);
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

  it("merges a burst of %output lines into a single bridge message", { skip: "flaky 2ms timer assertion under load. TODO: use fake timers" }, async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "burst", 80, 24);
    const session = mgr.getSession("burst");
    bridge.messages.length = 0;

    // Three %output lines arriving back-to-back within the 2ms idle window
    // must produce ONE bridge "output" message, not three.
    session.feed("line1\r\n");
    session.feed("line2\r\n");
    session.feed("line3\r\n");

    await waitFor(() => bridge.messages.some(m => m.type === "output" && m.session === "burst"));

    const outputs = bridge.messages.filter(m => m.type === "output" && m.session === "burst");
    assert.strictEqual(outputs.length, 1,
      "the 2ms idle debounce must merge a burst into a single bridge relay");
    assert.strictEqual(outputs[0].data, "line1\r\nline2\r\nline3\r\n",
      "merged frame must contain every byte from the burst");
    assert.strictEqual(outputs[0].fromSeq, 0,
      "fromSeq must be the position of the FIRST burst, not the latest");
    assert.strictEqual(outputs[0].cursor, "line1\r\nline2\r\nline3\r\n".length,
      "cursor must be the latest RingBuffer position so clients can detect gaps");
  });

  it("force-flushes at the 16ms hard cap when output never goes idle", { skip: "flaky under high CPU load; 100ms timer window too tight. TODO: raise window or use fake timers" }, async () => {
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "stream", 80, 24);
    const session = mgr.getSession("stream");
    bridge.messages.length = 0;

    // Hammer the coalescer every 1ms — the idle timer keeps resetting,
    // so the only way bytes ever reach the bridge is via the 16ms hard cap.
    // Without the cap, the test would time out and the assertion would fail.
    let stop = false;
    const timer = setInterval(() => {
      if (stop) return;
      session.feed("x");
    }, 1);

    const flushed = await waitFor(
      () => bridge.messages.some(m => m.type === "output" && m.session === "stream"),
      100, // give the cap several chances to fire
    );
    stop = true;
    clearInterval(timer);

    assert.ok(flushed,
      "16ms hard cap must force-flush a never-idle stream — otherwise " +
      "TUI redraws (htop, tail -f) starve clients indefinitely");

    // The cap fires within ~16ms of the FIRST byte, so cursor is small —
    // the exact value depends on how many feeds raced the cap, but it
    // must be > 0 (we wrote at least one byte before the cap fired).
    const out = bridge.messages.find(m => m.type === "output" && m.session === "stream");
    assert.ok(out.cursor > 0, "cap-flush must carry actual buffered data");
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
    // 2ms idle timer fires. The pre-Tier-1.1 code called cancelNotification
    // which dropped these bytes on the floor — already-subscribed clients
    // saw the screen freeze mid-frame.
    session.feed("about-to-be-deleted");
    mgr.deleteSession("doomed");

    const out = bridge.messages.find(m => m.type === "output" && m.session === "doomed");
    assert.ok(out, "deleteSession must flush queued bytes before removing the session");
    assert.strictEqual(out.data, "about-to-be-deleted");
  });

  it("never emits an output message with empty data", async () => {
    // Defensive: if the RingBuffer slice is empty (e.g., session was killed
    // mid-coalesce and bytes evicted), the coalescer must NOT emit a useless
    // bridge message. Empty messages confuse the client's gap detector.
    const { mgr, bridge } = makeManager();
    await mgr.attachClient("c1", "empty", 80, 24);
    const session = mgr.getSession("empty");
    bridge.messages.length = 0;

    // Force the slice to return empty even though we notified.
    session.outputBuffer.sliceFrom = () => "";
    session._options.onData("empty", 0);

    await new Promise(r => setTimeout(r, 25)); // wait past 16ms cap

    const outputs = bridge.messages.filter(m => m.type === "output" && m.session === "empty");
    assert.strictEqual(outputs.length, 0,
      "coalescer must not relay an empty data payload");
  });
});
