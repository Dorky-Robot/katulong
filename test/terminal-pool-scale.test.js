import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Regression test for fontSize scoping bug in scaleToFit (terminal-pool.js).
 *
 * The bug: `const fontSize` was declared inside an `if` block (only when
 * width changes >1px) but referenced outside it in the cellHeight
 * calculation. Since `const` is block-scoped, any call where width
 * did NOT change threw ReferenceError: fontSize is not defined.
 *
 * This reproduces the exact logic from scaleToFit using stubs so we can
 * test without a real DOM or xterm.js.
 */

// --- Shared constants matching terminal-pool.js ---
const FIXED_COLS = 120;

/**
 * Minimal reproduction of the scaleToFit cellHeight calculation.
 * Takes the same inputs and exercises the same code path.
 */
function computeRowsBuggy({ contentWidth, prevWidth, availableHeight, currentFontSize, hasDims, dimsCellHeight }) {
  // Simulates the if-block from scaleToFit where fontSize is block-scoped
  let updatedFontSize = currentFontSize;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    const fontSize = contentWidth / (120 * 0.6); // simplified fontSizeForWidth
    updatedFontSize = fontSize;
  }

  // BUG: references `fontSize` which is block-scoped above — throws ReferenceError
  // when the if-block is NOT entered (width unchanged)
  const cellHeight = hasDims
    ? dimsCellHeight / (updatedFontSize || 14) * fontSize // eslint-disable-line no-undef
    : fontSize * 1.2; // eslint-disable-line no-undef
  return Math.max(2, Math.floor(availableHeight / cellHeight));
}

/**
 * Fixed version: fontSize is hoisted out of the if-block.
 */
function computeRowsFixed({ contentWidth, prevWidth, availableHeight, currentFontSize, hasDims, dimsCellHeight }) {
  let fontSize = currentFontSize;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    fontSize = contentWidth / (120 * 0.6); // simplified fontSizeForWidth
  }

  const cellHeight = hasDims
    ? dimsCellHeight / (fontSize || 14) * fontSize
    : fontSize * 1.2;
  return Math.max(2, Math.floor(availableHeight / cellHeight));
}

// --- Stubbed scaleToFit matching the production logic (post-fix) ---
// Used by the tap-resize tests below.

/**
 * Reproduces the scaleToFit logic from terminal-pool.js with stubs.
 * Returns { cols, rows, changed } like the real function.
 */
function scaleToFitStub(term, container) {
  const { width, height, padLeft, padRight, padTop, padBottom } = container._rect;
  if (width === 0 || height === 0) return null;

  const contentWidth = width - padLeft - padRight;
  const prevWidth = container._lastScaleWidth || 0;
  let fontSize = term.options.fontSize || 14;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    container._lastScaleWidth = contentWidth;
    // simplified fontSizeForWidth
    fontSize = Math.max(6, Math.floor((contentWidth / (FIXED_COLS * 0.6)) * 2) / 2);
    term.options.fontSize = fontSize;
  }

  const availableHeight = height - padTop - padBottom;
  const cellHeight = fontSize * 1.2;
  const rows = Math.max(2, Math.floor(availableHeight / cellHeight));

  let changed = false;
  if (term.cols !== FIXED_COLS || term.rows !== rows) {
    term.cols = FIXED_COLS;
    term.rows = rows;
    term._resizeCount = (term._resizeCount || 0) + 1;
    changed = true;
  }
  return { cols: FIXED_COLS, rows, changed };
}

/**
 * Reproduces the ResizeObserver callback logic from terminal-pool.js.
 * OLD (buggy): uses exact float equality, unconditional refresh.
 */
function resizeObserverOld(state, width, height) {
  // Exact float comparison — subpixel changes pass through
  if (width === state.lastW && height === state.lastH) return;
  state.lastW = width;
  state.lastH = height;
  if (!state.term) return;
  scaleToFitStub(state.term, state.container);
  // Unconditional refresh — this is the bug
  state.refreshCount++;
  // Unconditional server notification — also buggy
  state.serverResizeCount++;
}

/**
 * Reproduces the ResizeObserver callback logic AFTER the fix.
 * Uses 1px threshold, only refreshes/notifies when changed.
 */
function resizeObserverFixed(state, width, height) {
  if (Math.abs(width - state.lastW) < 1 && Math.abs(height - state.lastH) < 1) return;
  state.lastW = width;
  state.lastH = height;
  if (!state.term) return;
  const result = scaleToFitStub(state.term, state.container);
  if (result?.changed) {
    state.refreshCount++;
    state.serverResizeCount++;
  }
}

function makeState(opts = {}) {
  return {
    lastW: opts.width || 800,
    lastH: opts.height || 600,
    refreshCount: 0,
    serverResizeCount: 0,
    term: {
      cols: FIXED_COLS,
      rows: opts.rows || 35,
      options: { fontSize: opts.fontSize || 14 },
      _resizeCount: 0,
    },
    container: {
      _lastScaleWidth: opts.width || 800,
      _rect: {
        width: opts.width || 800,
        height: opts.height || 600,
        padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
      },
    },
  };
}

describe("scaleToFit cellHeight calculation", () => {
  const baseArgs = {
    contentWidth: 800,
    prevWidth: 800,       // same width → if-block NOT entered
    availableHeight: 600,
    currentFontSize: 14,
    hasDims: false,
    dimsCellHeight: 0,
  };

  it("buggy version throws ReferenceError when width unchanged", () => {
    // This is the TDD red test — proves the bug exists
    assert.throws(
      () => computeRowsBuggy(baseArgs),
      { name: "ReferenceError" },
      "Expected ReferenceError for block-scoped fontSize accessed outside if-block"
    );
  });

  it("buggy version also throws when width unchanged and dims available", () => {
    assert.throws(
      () => computeRowsBuggy({ ...baseArgs, hasDims: true, dimsCellHeight: 16.8 }),
      { name: "ReferenceError" },
    );
  });

  it("fixed version returns valid rows when width unchanged", () => {
    const rows = computeRowsFixed(baseArgs);
    assert.ok(Number.isFinite(rows), `rows should be finite, got ${rows}`);
    assert.ok(rows >= 2, `rows should be >= 2, got ${rows}`);
  });

  it("fixed version returns valid rows when width unchanged and dims available", () => {
    const rows = computeRowsFixed({ ...baseArgs, hasDims: true, dimsCellHeight: 16.8 });
    assert.ok(Number.isFinite(rows), `rows should be finite, got ${rows}`);
    assert.ok(rows >= 2, `rows should be >= 2, got ${rows}`);
  });

  it("fixed version returns valid rows when width changes", () => {
    const rows = computeRowsFixed({ ...baseArgs, prevWidth: 0 });
    assert.ok(Number.isFinite(rows), `rows should be finite, got ${rows}`);
    assert.ok(rows >= 2, `rows should be >= 2, got ${rows}`);
  });

  it("fixed version calculates expected row count", () => {
    // fontSize = 14, cellHeight = 14 * 1.2 = 16.8, rows = floor(600 / 16.8) = 35
    const rows = computeRowsFixed(baseArgs);
    assert.equal(rows, 35);
  });
});

/**
 * Regression tests for the tap-resize bug (terminal-pool.js).
 *
 * The bug: tapping the terminal on iPad/mobile triggers a resize even though
 * the terminal dimensions haven't meaningfully changed. This happens because:
 *
 * 1. The ResizeObserver used exact float equality to filter changes, so
 *    subpixel shifts (e.g., 0.3px from a focus ring or safe-area recalc)
 *    passed through.
 *
 * 2. term.refresh() was called unconditionally after scaleToFit, even when
 *    no rows/cols changed.
 *
 * 3. fitActiveTerminal() sent a resize WS message to the server unconditionally,
 *    even when terminalPool.scale() didn't change anything.
 *
 * The fix:
 * - ResizeObserver uses 1px threshold (Math.abs) instead of exact equality
 * - scaleToFit returns { changed: boolean } and refresh/notify only fire when true
 * - fitActiveTerminal() no longer sends its own resize message (the pool's
 *   onResize callback handles it)
 */
describe("tap-resize bug", () => {
  describe("ResizeObserver subpixel guard", () => {
    it("OLD behavior: subpixel height change triggers refresh", () => {
      // Simulate initial state at 800x600, terminal already at 35 rows
      const state = makeState({ width: 800, height: 600, rows: 35 });

      // Simulate a tap that causes a 0.3px subpixel shift in height
      // (e.g., focus ring outline-offset, iOS safe-area recalculation)
      state.container._rect.height = 600.3;
      resizeObserverOld(state, 800, 600.3);

      // OLD: the subpixel change passes the exact equality check,
      // causing an unconditional refresh and server notification
      assert.equal(state.refreshCount, 1,
        "Old behavior incorrectly triggers refresh on subpixel change");
      assert.equal(state.serverResizeCount, 1,
        "Old behavior incorrectly notifies server on subpixel change");
    });

    it("FIXED behavior: subpixel height change is ignored", () => {
      const state = makeState({ width: 800, height: 600, rows: 35 });

      // Same subpixel shift
      state.container._rect.height = 600.3;
      resizeObserverFixed(state, 800, 600.3);

      // FIXED: 1px threshold filters out the subpixel change
      assert.equal(state.refreshCount, 0,
        "Fixed behavior should NOT refresh on subpixel change");
      assert.equal(state.serverResizeCount, 0,
        "Fixed behavior should NOT notify server on subpixel change");
    });

    it("FIXED behavior: subpixel width change is also ignored", () => {
      const state = makeState({ width: 800, height: 600, rows: 35 });
      resizeObserverFixed(state, 800.5, 600);

      assert.equal(state.refreshCount, 0,
        "Fixed behavior should NOT refresh on subpixel width change");
    });

    it("FIXED behavior: real height change (orientation/keyboard) still triggers resize", () => {
      const state = makeState({ width: 800, height: 600, rows: 35 });

      // Simulate keyboard appearing — significant height reduction
      state.container._rect.height = 400;
      resizeObserverFixed(state, 800, 400);

      // This IS a real resize — rows change from 35 to a smaller value
      assert.equal(state.refreshCount, 1,
        "Real height change should trigger refresh");
      assert.equal(state.serverResizeCount, 1,
        "Real height change should notify server");
      assert.ok(state.term.rows < 35,
        `Rows should decrease from 35, got ${state.term.rows}`);
    });

    it("FIXED behavior: orientation change (both dimensions) triggers resize", () => {
      const state = makeState({ width: 800, height: 600, rows: 35 });

      // Simulate landscape -> portrait rotation
      state.container._rect.width = 600;
      state.container._rect.height = 800;
      resizeObserverFixed(state, 600, 800);

      assert.equal(state.refreshCount, 1,
        "Orientation change should trigger refresh");
      assert.equal(state.serverResizeCount, 1,
        "Orientation change should notify server");
    });
  });

  describe("scaleToFit changed flag", () => {
    it("returns changed=false when rows are already correct", () => {
      const term = { cols: FIXED_COLS, rows: 35, options: { fontSize: 14 }, _resizeCount: 0 };
      const container = {
        _lastScaleWidth: 800,
        _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result.changed, false, "Should not change when rows match");
      assert.equal(term._resizeCount, 0, "Should not call resize");
    });

    it("returns changed=true when height changes enough to alter rows", () => {
      const term = { cols: FIXED_COLS, rows: 35, options: { fontSize: 14 }, _resizeCount: 0 };
      const container = {
        _lastScaleWidth: 800,
        _rect: { width: 800, height: 400, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result.changed, true, "Should change when rows differ");
      assert.equal(term._resizeCount, 1, "Should call resize once");
    });

    it("returns null for zero-size container", () => {
      const term = { cols: FIXED_COLS, rows: 35, options: { fontSize: 14 } };
      const container = {
        _rect: { width: 0, height: 0, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result, null);
    });
  });

  describe("repeated taps don't accumulate resizes", () => {
    it("multiple subpixel jitters cause zero resizes", () => {
      const state = makeState({ width: 800, height: 600, rows: 35 });

      // Simulate 10 rapid taps, each causing tiny subpixel jitter
      const jitters = [0.1, -0.2, 0.3, -0.1, 0.4, -0.3, 0.2, -0.4, 0.1, -0.2];
      for (const jitter of jitters) {
        state.container._rect.height = 600 + jitter;
        resizeObserverFixed(state, 800, 600 + jitter);
      }

      assert.equal(state.refreshCount, 0,
        "No refreshes should fire from subpixel jitter");
      assert.equal(state.serverResizeCount, 0,
        "No server notifications from subpixel jitter");
      assert.equal(state.term._resizeCount, 0,
        "No term.resize calls from subpixel jitter");
    });
  });
});
