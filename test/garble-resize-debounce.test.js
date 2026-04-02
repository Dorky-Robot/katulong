/**
 * Tests for two garble-prevention fixes:
 *
 * 1. Resize debounce (terminal-pool.js) — coalesces rapid SIGWINCH notifications
 *    so TUI apps are not interrupted mid-render by multiple back-to-back resizes.
 *
 * 2. resizeSync effect handler (websocket-connection.js) — calls deps.fit()
 *    instead of blindly applying another client's cols/rows via t.resize().
 */

import { describe, it, before } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// ======================================================================
// Part 1: Resize debounce (stub-based, no DOM required)
// ======================================================================

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

// ======================================================================
// Part 2: resizeSync effect handler (websocket-connection.js)
// ======================================================================

// Register custom resolver for browser-style absolute imports
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

// mock.module requires Node >=22.3 with --experimental-test-module-mocks.
// Guard gracefully so these tests simply skip on older runtimes.
if (typeof mock.module !== "function") {
  describe("resizeSync effect handler", () => {
    it("skipped: mock.module not available in this Node version", () => {});
  });
} else {
  // Mock browser-only modules
  const scrollUtilsUrl = new URL("../public/lib/scroll-utils.js", import.meta.url).href;
  const basePathUrl = new URL("../public/lib/base-path.js", import.meta.url).href;

  await mock.module(scrollUtilsUrl, {
    namedExports: {
      scrollToBottom: () => {},
      terminalWriteWithScroll: () => {},
      viewportOf: () => null,
      isAtBottom: () => true,
    },
  });

  await mock.module(basePathUrl, {
    namedExports: {
      basePath: "",
    },
  });

  const { createWebSocketConnection } = await import("../public/lib/websocket-connection.js");

  function makeState(overrides = {}) {
    return {
      session: { name: "default", ...overrides.session },
      connection: { ws: null, attached: false, reconnectDelay: 1000, ...overrides.connection },
      scroll: { userScrolledUpBeforeDisconnect: false, ...overrides.scroll },
      update(path, value) {
        const keys = path.split(".");
        let obj = this;
        for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
        obj[keys[keys.length - 1]] = value;
        return this;
      },
      updateMany(updates) {
        Object.entries(updates).forEach(([path, value]) => this.update(path, value));
        return this;
      },
    };
  }

  describe("resizeSync effect handler (websocket-connection.js)", () => {
    it("calls deps.fit() when resizeSync effect is executed", () => {
      let fitCalled = false;
      const state = makeState();
      const conn = createWebSocketConnection({
        state,
        term: () => null,
        isAtBottom: () => true,
        fit: () => { fitCalled = true; },
      });

      conn.executeEffect({ type: "resizeSync", cols: 120, rows: 40 });
      assert.ok(fitCalled, "resizeSync should call deps.fit()");
    });

    it("does NOT call t.resize() directly", () => {
      let resizeCalled = false;
      let fitCalled = false;
      const mockTerm = {
        resize: () => { resizeCalled = true; },
        cols: 80,
        rows: 24,
      };
      const state = makeState();
      const conn = createWebSocketConnection({
        state,
        term: () => mockTerm,
        isAtBottom: () => true,
        fit: () => { fitCalled = true; },
      });

      conn.executeEffect({ type: "resizeSync", cols: 120, rows: 40 });
      assert.ok(fitCalled, "Should call deps.fit()");
      assert.ok(!resizeCalled, "Should NOT call t.resize() — fit handles it");
    });

    it("does not crash when deps.fit is not provided", () => {
      const state = makeState();
      const conn = createWebSocketConnection({
        state,
        term: () => null,
        isAtBottom: () => true,
        // fit intentionally omitted
      });

      // Should not throw
      assert.doesNotThrow(() => {
        conn.executeEffect({ type: "resizeSync", cols: 120, rows: 40 });
      }, "resizeSync should handle missing deps.fit gracefully");
    });
  });

  describe("resize-sync message handler produces resizeSync effect", () => {
    it("handler returns effect with cols and rows from message", () => {
      const state = makeState();
      const conn = createWebSocketConnection({
        state,
        term: () => null,
        isAtBottom: () => true,
      });

      const result = conn.wsMessageHandlers["resize-sync"]({ cols: 130, rows: 50 });
      assert.deepStrictEqual(result.stateUpdates, {});
      assert.equal(result.effects.length, 1);
      const eff = result.effects[0];
      assert.equal(eff.type, "resizeSync");
      assert.equal(eff.cols, 130);
      assert.equal(eff.rows, 50);
    });
  });
}
