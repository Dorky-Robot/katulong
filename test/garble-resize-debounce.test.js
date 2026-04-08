/**
 * Tests for the terminal-pool.js resize debounce.
 *
 * Coalesces rapid SIGWINCH notifications so TUI apps are not interrupted
 * mid-render by multiple back-to-back resizes. This complements the
 * server-side resize gate in lib/session.js — the client debounces at the
 * source (xterm container ResizeObserver) and the server gates at the
 * tmux control mode boundary.
 *
 * Raptor 3 deleted the `resize-sync` bridge message; clients now apply
 * dim transitions only through `applySnapshot` when the server emits
 * a snapshot message, so the old `resizeSync` effect-handler tests that
 * used to live here are gone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Reproduce the debouncedResize logic from terminal-pool.js.
 * This is an exact copy of the production code so we can test the
 * coalescing behavior without needing xterm.js or a real DOM.
 */
function createDebouncedResize(onResize) {
  const timers = new Map();
  return function debouncedResize(sessionName, cols, rows) {
    clearTimeout(timers.get(sessionName));
    timers.set(sessionName, setTimeout(() => {
      timers.delete(sessionName);
      if (onResize) onResize(sessionName, cols, rows);
    }, 80));
  };
}

/** Helper: wait for timers to flush (>80ms debounce window). */
const flush = () => new Promise((r) => setTimeout(r, 150));

describe("resize debounce (terminal-pool.js)", () => {
  it("single resize fires after debounce period", async () => {
    const calls = [];
    const debounced = createDebouncedResize((s, c, r) => calls.push({ s, c, r }));

    debounced("sess-1", 120, 40);
    // Should not have fired yet (within 80ms window)
    assert.equal(calls.length, 0, "Should not fire synchronously");

    await flush();
    assert.equal(calls.length, 1, "Should fire exactly once after debounce");
    assert.deepStrictEqual(calls[0], { s: "sess-1", c: 120, r: 40 });
  });

  it("rapid resizes are coalesced into one call with last values", async () => {
    const calls = [];
    const debounced = createDebouncedResize((s, c, r) => calls.push({ s, c, r }));

    // Simulate 5 rapid resizes (e.g., window drag or orientation animation)
    debounced("sess-1", 120, 30);
    debounced("sess-1", 120, 32);
    debounced("sess-1", 120, 35);
    debounced("sess-1", 120, 38);
    debounced("sess-1", 120, 40);

    await flush();
    assert.equal(calls.length, 1, "Should coalesce into a single call");
    assert.deepStrictEqual(calls[0], { s: "sess-1", c: 120, r: 40 },
      "Should use the LAST values (rows=40)");
  });

  it("different sessions are debounced independently", async () => {
    const calls = [];
    const debounced = createDebouncedResize((s, c, r) => calls.push({ s, c, r }));

    debounced("session-a", 120, 30);
    debounced("session-b", 120, 50);

    await flush();
    assert.equal(calls.length, 2, "Should fire once per session");
    const sessions = calls.map((c) => c.s).sort();
    assert.deepStrictEqual(sessions, ["session-a", "session-b"]);
    assert.deepStrictEqual(
      calls.find((c) => c.s === "session-a"),
      { s: "session-a", c: 120, r: 30 }
    );
    assert.deepStrictEqual(
      calls.find((c) => c.s === "session-b"),
      { s: "session-b", c: 120, r: 50 }
    );
  });

  it("debounce timer resets on each call within the window", async () => {
    const calls = [];
    const debounced = createDebouncedResize((s, c, r) => calls.push({ s, c, r }));

    // Call, wait 50ms (less than 80ms), call again, wait 50ms, call again
    debounced("sess-1", 120, 30);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, "Should not fire after 50ms");

    debounced("sess-1", 120, 35);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, "Timer reset — should not fire after another 50ms");

    debounced("sess-1", 120, 40);
    await flush();
    assert.equal(calls.length, 1, "Should fire exactly once after final debounce");
    assert.equal(calls[0].r, 40, "Should use the last value (rows=40)");
  });
});
