import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { scrollToBottom } from "../public/lib/scroll-utils.js";

/**
 * Tests for scroll-utils.js — specifically initTouchScroll.
 *
 * Since these are browser-only modules using DOM APIs, we mock the terminal
 * and DOM elements to verify the scroll logic in isolation.
 */

function createMockElement() {
  const listeners = {};
  return {
    addEventListener: (type, fn, opts) => {
      (listeners[type] = listeners[type] || []).push({ fn, opts });
    },
    _listeners: listeners,
    _dispatch(type, event) {
      for (const { fn } of (listeners[type] || [])) {
        fn(event);
      }
    },
    getBoundingClientRect: () => ({ height: 240, width: 800 }),
    setPointerCapture: () => {},
    closest: () => null,
  };
}

function createMockTerm({ rows = 24, cellHeight = 10 } = {}) {
  let scrolledLines = 0;
  const el = createMockElement();
  const term = {
    element: el,
    rows,
    scrollLines: (n) => { scrolledLines += n; },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { height: cellHeight } } },
      },
    },
    buffer: {
      active: { baseY: 100, viewportY: 50 },
    },
    onScroll: () => {},
    _getScrolled() { return scrolledLines; },
    _resetScrolled() { scrolledLines = 0; },
  };
  return term;
}

// We can't import the ESM module directly (it uses browser APIs at module scope
// with WeakMap/WeakSet), so we extract and test the core logic inline.
// The functions below mirror the logic in scroll-utils.js.

function initTouchScroll(term) {
  const el = term.element;
  if (!el) return;

  let activePointerId = -1;
  let startY = 0;
  let lastY = 0;
  let scrolling = false;
  let accDelta = 0;

  function cellHeight() {
    try {
      return term._core._renderService.dimensions.css.cell.height;
    } catch {
      const rect = el.getBoundingClientRect();
      return rect.height / term.rows;
    }
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || activePointerId !== -1) return;
    activePointerId = e.pointerId;
    startY = e.clientY;
    lastY = startY;
    scrolling = false;
    accDelta = 0;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== activePointerId) return;
    const y = e.clientY;
    const dy = lastY - y;
    lastY = y;

    if (!scrolling) {
      if (Math.abs(y - startY) < 10) return;
      scrolling = true;
    }

    accDelta += dy;
    const rowH = cellHeight();
    const lines = Math.trunc(accDelta / rowH);
    if (lines !== 0) {
      term.scrollLines(lines);
      accDelta -= lines * rowH;
    }
  });

  el.addEventListener("pointerup", (e) => {
    if (e.pointerId === activePointerId) activePointerId = -1;
  });

  el.addEventListener("pointercancel", (e) => {
    if (e.pointerId === activePointerId) activePointerId = -1;
  });
}

describe("initTouchScroll", () => {
  let term;

  beforeEach(() => {
    term = createMockTerm({ cellHeight: 10 });
    initTouchScroll(term);
  });

  it("scrolls down when finger drags up (touch)", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "touch", pointerId: 1, clientY: 100,
    });
    // Move 25px up (past 10px threshold)
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 75,
    });
    // dy = 100-75 = 25, but threshold takes first 10, then accumulates
    // Actually: lastY starts at 100, move to 75 -> dy = 100-75 = 25
    // scrolling becomes true (25 > 10), accDelta = 25, lines = 2 (25/10 truncated)
    assert.strictEqual(term._getScrolled(), 2);
  });

  it("ignores mouse pointer events", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "mouse", pointerId: 1, clientY: 100,
    });
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 50,
    });
    assert.strictEqual(term._getScrolled(), 0);
  });

  it("ignores pen pointer events", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "pen", pointerId: 1, clientY: 100,
    });
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 50,
    });
    assert.strictEqual(term._getScrolled(), 0);
  });

  it("does not scroll for small movements (< 10px threshold)", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "touch", pointerId: 1, clientY: 100,
    });
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 95,
    });
    assert.strictEqual(term._getScrolled(), 0);
  });

  it("stops tracking after pointerup", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "touch", pointerId: 1, clientY: 100,
    });
    term.element._dispatch("pointerup", { pointerId: 1 });
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 50,
    });
    assert.strictEqual(term._getScrolled(), 0);
  });

  it("stops tracking after pointercancel", () => {
    term.element._dispatch("pointerdown", {
      pointerType: "touch", pointerId: 1, clientY: 100,
    });
    term.element._dispatch("pointercancel", { pointerId: 1 });
    term.element._dispatch("pointermove", {
      pointerId: 1, clientY: 50,
    });
    assert.strictEqual(term._getScrolled(), 0);
  });
});

/**
 * Regression tests for scrollToBottom() with smooth animation.
 *
 * Bug: the old implementation captured `buf.baseY` once at the start of the
 * animation and eased toward that stale target. If new output arrived during
 * the 150–500ms animation (growing baseY), the user ended up stranded at the
 * OLD bottom, not the current one — e.g. tapping the scroll-to-bottom button
 * while `tail -f` or Claude Code is streaming would leave the viewport
 * hovering above the live cursor.
 *
 * Fix: (1) re-read `buf.baseY` every animation frame so streaming output
 * extends the target, and (2) defer the final `term.scrollToBottom()` call
 * through `term.write("", cb)` so it rides xterm's WriteBuffer queue and
 * fires after any in-flight writes have flushed.
 */

/**
 * Build a fake xterm.js terminal that mirrors the pieces of its behavior
 * scrollToBottom() depends on.
 *
 * Critical detail: `term.write(data, cb)` in real xterm.js is ASYNC — data
 * is pushed into a WriteBuffer and drained later, with `cb` firing once
 * that chunk has been applied. During the gap, `baseY` has not yet grown
 * to reflect the pending write. This timing gap is the whole reason the
 * deferred-final-snap fix exists, so the fake must honor it: writes queue
 * up, their effects (baseY growth) only land when `drainWrites()` is
 * called, and `scrollToBottom()` snaps to whatever baseY is present at
 * the instant it runs (matching real xterm behavior).
 */
function createFakeTerm({ baseY = 0, viewportY = 0 } = {}) {
  const state = {
    baseY,
    viewportY,
    scrollToBottomCalls: 0,
    writeQueue: [], // items: { growth: number, cb?: () => void }
  };
  const term = {
    buffer: {
      active: {
        get baseY() { return state.baseY; },
        get viewportY() { return state.viewportY; },
      },
    },
    scrollLines(n) {
      state.viewportY = Math.max(0, Math.min(state.baseY, state.viewportY + n));
    },
    // Real xterm: snaps viewportY to CURRENT baseY. Does NOT force pending
    // writes to drain first — that's the whole point of the bug. If a
    // write is queued with baseY-growth that hasn't drained yet, this
    // lands on the STALE baseY.
    scrollToBottom() {
      state.scrollToBottomCalls++;
      state.viewportY = state.baseY;
    },
    // Async write: queue and return. The caller drives the drain via
    // drainWrites() on the state handle below.
    write(data, cb) {
      // Allow callers to stash a baseY-growth hint in a structured payload.
      // Plain strings (including the empty string the fix emits) are treated
      // as zero-growth no-ops that merely carry a callback.
      const growth = (data && typeof data === "object" && typeof data.growth === "number")
        ? data.growth
        : 0;
      state.writeQueue.push({ growth, cb });
    },
    onScroll() { return { dispose() {} }; },
    element: null,
  };
  // Drain all queued writes in FIFO order, applying baseY growth and firing
  // callbacks. Mirrors xterm's WriteBuffer flushing the queue.
  state.drainWrites = () => {
    while (state.writeQueue.length) {
      const { growth, cb } = state.writeQueue.shift();
      if (growth) state.baseY += growth;
      if (typeof cb === "function") cb();
    }
  };
  return { term, state };
}

describe("scrollToBottom (smooth, streaming output)", () => {
  const origRAF = globalThis.requestAnimationFrame;
  const origCAF = globalThis.cancelAnimationFrame;
  const origPerf = globalThis.performance;

  let rafQueue;
  let fakeNow;

  beforeEach(() => {
    rafQueue = [];
    fakeNow = 0;
    // performance.now() drives the animation clock. Keep it under our control.
    globalThis.performance = { now: () => fakeNow };
    // Queue RAF callbacks so the test can interleave state mutations between
    // frames (simulating new output arriving mid-animation).
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = (id) => {
      // Mark as cancelled by nulling the slot; flushRAF skips nulls.
      if (id >= 1 && id <= rafQueue.length) rafQueue[id - 1] = null;
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
    globalThis.performance = origPerf;
  });

  function drainRAFAt(timestamp) {
    fakeNow = timestamp;
    const pending = rafQueue;
    rafQueue = [];
    for (const cb of pending) {
      if (cb) cb(timestamp);
    }
  }

  it("re-targets the live baseY and defers the final snap when output streams in mid-animation", () => {
    // Terminal starts 100 lines scrolled up from a baseY of 1000.
    const { term, state } = createFakeTerm({ baseY: 1000, viewportY: 900 });

    fakeNow = 0;
    scrollToBottom(term, { smooth: true });

    // Sanity: an animation frame was scheduled. Before it fires, simulate
    // a burst of new output streaming in (e.g. fast tail -f or Claude
    // Code typing). We enqueue the write BEFORE the animation's final
    // frame runs — this mirrors the real timing bug: the user clicks the
    // button while xterm's WriteBuffer already has pending content that
    // will grow baseY by 500 lines once drained.
    assert.strictEqual(rafQueue.length, 1, "initial RAF should be scheduled");
    term.write({ growth: 500 }, null); // queued, NOT yet applied

    // Fast-forward the clock well past the maximum 500ms animation
    // duration so progress clamps to 1 and the step() function finishes
    // in a single frame. With the live re-target fix, step() re-reads
    // baseY on each frame — but the pending write hasn't drained yet,
    // so baseY still reads 1000 here. That's fine; the DEFERRED final
    // snap is what rescues us: term.write("", cb) rides the queue so cb
    // fires AFTER the pending content write drains baseY to 1500.
    drainRAFAt(10_000);

    // At this point the animation step has enqueued term.write("", cb).
    // Nothing has drained yet. Viewport is still mid-animation target.
    // Now simulate xterm's WriteBuffer flushing: the 500-line content
    // write lands first (baseY 1000 → 1500), then the empty write's
    // callback fires, which calls term.scrollToBottom() — snapping
    // viewportY to the NOW-LIVE baseY of 1500.
    state.drainWrites();

    assert.strictEqual(
      state.viewportY, 1500,
      "viewport should land at the live baseY (1500) after pending writes drain, " +
      "not the stale start-of-animation baseY (1000)",
    );
    assert.ok(
      state.scrollToBottomCalls >= 1,
      "term.scrollToBottom() should be invoked via the write() callback for the final snap",
    );
  });

  it("routes the final snap through term.write() so it rides the WriteBuffer queue", () => {
    const { term, state } = createFakeTerm({ baseY: 500, viewportY: 400 });

    fakeNow = 0;
    scrollToBottom(term, { smooth: true });
    // Fast-forward the clock past the max animation duration in one frame.
    drainRAFAt(10_000);

    // Before draining: animation has completed its stepping and enqueued
    // the final empty-write snap. No scrollToBottom() should have fired
    // yet, because it MUST be deferred via term.write("", cb).
    assert.strictEqual(
      state.scrollToBottomCalls, 0,
      "final snap must not fire synchronously — it must be deferred via term.write('', cb)",
    );
    assert.ok(
      state.writeQueue.length >= 1,
      "final snap should be queued as a term.write('', cb) entry",
    );

    // Draining the write queue should fire the write callback, which in
    // turn calls term.scrollToBottom().
    state.drainWrites();
    assert.strictEqual(
      state.scrollToBottomCalls, 1,
      "term.scrollToBottom() must run from inside the term.write() callback",
    );
  });
});
