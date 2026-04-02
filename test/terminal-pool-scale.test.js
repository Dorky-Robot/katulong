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
const DEFAULT_COLS = 82;
const CHAR_RATIO = 0.6; // monospace char width / font size (approximate)

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

// Simulates window.innerWidth for viewport-aware centering gap tests.
let stubViewportWidth = 1024;

/**
 * Calculate font size for a given width and column count.
 * Mirrors fontSizeForWidth in terminal-pool.js.
 */
function fontSizeForWidthStub(width, cols) {
  const charRatio = CHAR_RATIO;
  const exactSize = width / (cols * charRatio);
  return Math.max(6, Math.floor(exactSize * 2) / 2);
}

/**
 * Reproduces the scaleToFit logic from terminal-pool.js with stubs.
 * Returns { cols, rows, changed } like the real function.
 *
 * Variable cols: calculates cols from contentWidth / charWidth instead
 * of always using a fixed column count. DEFAULT_COLS is only used as
 * fallback when dimensions can't be calculated.
 */
function scaleToFitStub(term, container) {
  const { width, height, padLeft, padRight, padTop, padBottom } = container._rect;
  if (width === 0 || height === 0) return null;

  const contentWidth = width - padLeft - padRight;
  const prevWidth = container._lastScaleWidth || 0;
  let fontSize = term.options.fontSize || 14;
  let cols = term.cols || DEFAULT_COLS;
  if (Math.abs(contentWidth - prevWidth) > 1) {
    container._lastScaleWidth = contentWidth;
    // Viewport-aware centering gap: 2px on phones (<600px), 8px on wider
    const centeringGap = stubViewportWidth < 600 ? 2 : 8;
    const availableWidth = contentWidth - centeringGap;

    // Calculate cols from available width at the current font size.
    // charWidth = fontSize * CHAR_RATIO
    const charWidth = fontSize * CHAR_RATIO;
    cols = Math.max(2, Math.floor(availableWidth / charWidth));

    // Recalculate font size to exactly fit the calculated cols
    fontSize = fontSizeForWidthStub(availableWidth, cols);
    term.options.fontSize = fontSize;
  }

  const availableHeight = height - padTop - padBottom;
  const cellHeight = fontSize * 1.2;
  const rows = Math.max(2, Math.floor(availableHeight / cellHeight));

  let changed = false;
  if (term.cols !== cols || term.rows !== rows) {
    term.cols = cols;
    term.rows = rows;
    term._resizeCount = (term._resizeCount || 0) + 1;
    changed = true;
  }
  return { cols, rows, changed };
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
  // Calculate expected cols for the given width at the initial font size
  const fontSize = opts.fontSize || 14;
  const gap = (opts.viewportWidth || stubViewportWidth) < 600 ? 2 : 8;
  const contentW = (opts.width || 800) - (opts.padLeft || 0) - (opts.padRight || 0);
  const charWidth = fontSize * CHAR_RATIO;
  const expectedCols = opts.cols || Math.max(2, Math.floor((contentW - gap) / charWidth));

  return {
    lastW: opts.width || 800,
    lastH: opts.height || 600,
    refreshCount: 0,
    serverResizeCount: 0,
    term: {
      cols: expectedCols,
      rows: opts.rows || 35,
      options: { fontSize },
      _resizeCount: 0,
    },
    container: {
      _lastScaleWidth: opts.width || 800,
      _rect: {
        width: opts.width || 800,
        height: opts.height || 600,
        padLeft: opts.padLeft || 0,
        padRight: opts.padRight || 0,
        padTop: 0,
        padBottom: 0,
      },
    },
  };
}

describe("scaleToFit cellHeight calculation", () => {
  const baseArgs = {
    contentWidth: 800,
    prevWidth: 800,       // same width -> if-block NOT entered
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
      // Simulate initial state at 800x600
      const state = makeState({ width: 800, height: 600 });

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
      const state = makeState({ width: 800, height: 600 });

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
      const state = makeState({ width: 800, height: 600 });
      resizeObserverFixed(state, 800.5, 600);

      assert.equal(state.refreshCount, 0,
        "Fixed behavior should NOT refresh on subpixel width change");
    });

    it("FIXED behavior: real height change (orientation/keyboard) still triggers resize", () => {
      const state = makeState({ width: 800, height: 600 });
      const initialRows = state.term.rows;

      // Simulate keyboard appearing — significant height reduction
      state.container._rect.height = 400;
      resizeObserverFixed(state, 800, 400);

      // This IS a real resize — rows change from initial value to a smaller value
      assert.equal(state.refreshCount, 1,
        "Real height change should trigger refresh");
      assert.equal(state.serverResizeCount, 1,
        "Real height change should notify server");
      assert.ok(state.term.rows < initialRows,
        `Rows should decrease from ${initialRows}, got ${state.term.rows}`);
    });

    it("FIXED behavior: orientation change (both dimensions) triggers resize", () => {
      const state = makeState({ width: 800, height: 600 });

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
    it("returns changed=false when dimensions are already correct", () => {
      // Create a term with cols/rows that match what scaleToFit would calculate
      // for an 800x600 container at 14px font
      const charWidth = 14 * CHAR_RATIO;
      const expectedCols = Math.max(2, Math.floor((800 - 8) / charWidth));
      const expectedRows = Math.max(2, Math.floor(600 / (14 * 1.2)));
      const term = { cols: expectedCols, rows: expectedRows, options: { fontSize: 14 }, _resizeCount: 0 };
      const container = {
        _lastScaleWidth: 800,
        _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result.changed, false, "Should not change when dimensions match");
      assert.equal(term._resizeCount, 0, "Should not call resize");
    });

    it("returns changed=true when height changes enough to alter rows", () => {
      const charWidth = 14 * CHAR_RATIO;
      const expectedCols = Math.max(2, Math.floor((800 - 8) / charWidth));
      const term = { cols: expectedCols, rows: 35, options: { fontSize: 14 }, _resizeCount: 0 };
      const container = {
        _lastScaleWidth: 800,
        _rect: { width: 800, height: 400, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result.changed, true, "Should change when rows differ");
      assert.equal(term._resizeCount, 1, "Should call resize once");
    });

    it("returns null for zero-size container", () => {
      const term = { cols: DEFAULT_COLS, rows: 35, options: { fontSize: 14 } };
      const container = {
        _rect: { width: 0, height: 0, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
      };
      const result = scaleToFitStub(term, container);
      assert.equal(result, null);
    });
  });

  describe("repeated taps don't accumulate resizes", () => {
    it("multiple subpixel jitters cause zero resizes", () => {
      const state = makeState({ width: 800, height: 600 });

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

/**
 * Tests for viewport-aware centering gap in scaleToFit.
 *
 * On phones (<600px viewport), the centering gap is reduced from 8px to 2px
 * to maximize horizontal terminal space. This gives 6 extra pixels to the
 * font-size calculation, yielding a larger font and more usable columns.
 */
describe("viewport-aware centering gap", () => {
  it("uses 2px gap on narrow viewport (<600px), yielding more cols", () => {
    stubViewportWidth = 375; // iPhone SE width
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 375, height: 667, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    const result = scaleToFitStub(term, container);
    const narrowCols = term.cols;

    // Reset and test with wide viewport (8px gap) for same container width
    stubViewportWidth = 1024;
    const term2 = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container2 = {
      _lastScaleWidth: 0,
      _rect: { width: 375, height: 667, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term2, container2);
    const wideCols = term2.cols;

    // Narrow viewport should get more (or equal) cols because gap is smaller (2px vs 8px)
    assert.ok(narrowCols >= wideCols,
      `Narrow viewport cols (${narrowCols}) should be >= wide viewport cols (${wideCols})`);
    assert.ok(result !== null, "Should return a valid result");
  });

  it("uses 8px gap on wide viewport (>=600px)", () => {
    stubViewportWidth = 1024;
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    // With 8px gap, available = 792, charWidth = 14 * 0.6 = 8.4, cols = floor(792 / 8.4)
    const charWidth = 14 * CHAR_RATIO;
    const expectedCols = Math.max(2, Math.floor((800 - 8) / charWidth));
    assert.equal(term.cols, expectedCols,
      `Cols should match 8px gap calculation (${expectedCols})`);
  });

  it("uses 2px gap at exactly 599px viewport", () => {
    stubViewportWidth = 599;
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 599, height: 800, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    const charWidth = 14 * CHAR_RATIO;
    const expectedCols = Math.max(2, Math.floor((599 - 2) / charWidth));
    assert.equal(term.cols, expectedCols,
      `Cols at 599px viewport should use 2px gap (${expectedCols})`);
  });

  it("uses 8px gap at exactly 600px viewport", () => {
    stubViewportWidth = 600;
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 600, height: 800, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    const charWidth = 14 * CHAR_RATIO;
    const expectedCols = Math.max(2, Math.floor((600 - 8) / charWidth));
    assert.equal(term.cols, expectedCols,
      `Cols at 600px viewport should use 8px gap (${expectedCols})`);
  });

  // Reset stubViewportWidth after tests
  it("cleanup: reset stubViewportWidth", () => {
    stubViewportWidth = 1024;
    assert.ok(true);
  });
});

/**
 * Variable column width tests.
 *
 * scaleToFit now calculates cols from contentWidth / charWidth instead of
 * always using a fixed column count. Different viewport widths yield
 * different column counts, enabling each client to negotiate its own width.
 */
describe("variable column width", () => {
  it("narrow viewport (375px) gets fewer cols than wide viewport (1440px)", () => {
    stubViewportWidth = 375;
    const narrowTerm = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const narrowContainer = {
      _lastScaleWidth: 0,
      _rect: { width: 375, height: 667, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(narrowTerm, narrowContainer);

    stubViewportWidth = 1440;
    const wideTerm = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const wideContainer = {
      _lastScaleWidth: 0,
      _rect: { width: 1440, height: 900, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(wideTerm, wideContainer);

    assert.ok(narrowTerm.cols < wideTerm.cols,
      `Narrow (${narrowTerm.cols}) should have fewer cols than wide (${wideTerm.cols})`);

    // Narrow (375px) at 14px font: charWidth = 8.4, available = 373, cols ~= 44
    assert.ok(narrowTerm.cols >= 40 && narrowTerm.cols <= 50,
      `Narrow cols (${narrowTerm.cols}) should be roughly 40-50`);

    // Wide (1440px) at 14px font: charWidth = 8.4, available = 1432, cols ~= 170
    assert.ok(wideTerm.cols >= 160 && wideTerm.cols <= 180,
      `Wide cols (${wideTerm.cols}) should be roughly 160-180`);

    // Reset
    stubViewportWidth = 1024;
  });

  it("medium viewport (800px) gets an intermediate number of cols", () => {
    stubViewportWidth = 800;
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    // 800px at 14px: charWidth = 8.4, available = 792, cols ~= 94
    assert.ok(term.cols > 80 && term.cols < 120,
      `Medium viewport cols (${term.cols}) should be between 80 and 120`);

    stubViewportWidth = 1024;
  });

  it("cols are NOT fixed at DEFAULT_COLS (82) for different widths", () => {
    stubViewportWidth = 1024;

    // Test a wide container — cols should NOT be 82
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 1200, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    assert.notEqual(term.cols, DEFAULT_COLS,
      `Cols (${term.cols}) should NOT always be ${DEFAULT_COLS} — they should vary with width`);
    assert.ok(term.cols > DEFAULT_COLS,
      `1200px container at 14px font should yield more than ${DEFAULT_COLS} cols, got ${term.cols}`);
  });

  it("uses DEFAULT_COLS as fallback when container has zero dimensions", () => {
    const term = { cols: DEFAULT_COLS, rows: 24, options: { fontSize: 14 } };
    const container = {
      _rect: { width: 0, height: 0, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    const result = scaleToFitStub(term, container);
    assert.equal(result, null, "Should return null for zero-size container");
    assert.equal(term.cols, DEFAULT_COLS,
      "Term cols should remain at DEFAULT_COLS when container can't be measured");
  });

  it("returns correct cols in the result object", () => {
    stubViewportWidth = 1024;
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    const result = scaleToFitStub(term, container);

    assert.equal(result.cols, term.cols,
      "Result cols should match the terminal's cols");
    assert.ok(result.cols > 0, "Cols should be positive");
  });

  it("font size stays constant at 14px (not scaled to fit fixed cols)", () => {
    stubViewportWidth = 1024;

    // Test that font size remains at the initial value (14px)
    // rather than being scaled to fit a fixed number of cols
    const term = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const container = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term, container);

    // Font size should be close to the initial 14px, not scaled wildly
    // The fontSizeForWidth recalculation rounds to fit exactly, so it
    // may adjust slightly, but should stay reasonable
    assert.ok(term.options.fontSize >= 10 && term.options.fontSize <= 18,
      `Font size (${term.options.fontSize}) should stay reasonable, not wildly scaled`);
  });

  it("container padding reduces available width and cols", () => {
    stubViewportWidth = 1024;

    // No padding
    const term1 = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const c1 = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term1, c1);

    // With padding
    const term2 = { cols: 0, rows: 0, options: { fontSize: 14 }, _resizeCount: 0 };
    const c2 = {
      _lastScaleWidth: 0,
      _rect: { width: 800, height: 600, padLeft: 40, padRight: 40, padTop: 0, padBottom: 0 },
    };
    scaleToFitStub(term2, c2);

    assert.ok(term2.cols < term1.cols,
      `Padded container (${term2.cols} cols) should have fewer cols than unpadded (${term1.cols} cols)`);
  });
});
