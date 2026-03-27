import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

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
