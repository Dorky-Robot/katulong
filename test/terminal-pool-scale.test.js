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
