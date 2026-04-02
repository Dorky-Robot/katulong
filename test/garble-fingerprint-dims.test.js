/**
 * Tests for the screen fingerprint dimensions fix.
 *
 * The fix: screenFingerprint() now includes terminal.cols and terminal.rows
 * in the DJB2 hash (before cursor position and row content). This ensures
 * that a cols/rows mismatch between client and server is detected as drift,
 * even when the visible content happens to be identical after reflow.
 *
 * Tests the client-side pure function directly with mock terminal objects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Register a custom resolver that redirects /lib/ and /vendor/ to public/.
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

const { screenFingerprint } = await import("../public/lib/screen-fingerprint.js");

/**
 * Create a mock terminal object matching the xterm.js interface that
 * screenFingerprint() reads: cols, rows, buffer.active.{baseY, cursorX, cursorY, getLine}.
 */
function makeMockTerminal(cols, rows, cursorX = 0, cursorY = 0, lines = []) {
  const lineObjs = [];
  for (let y = 0; y < rows; y++) {
    lineObjs.push({
      translateToString: () => lines[y] || "",
    });
  }
  return {
    cols,
    rows,
    buffer: {
      active: {
        baseY: 0,
        cursorX,
        cursorY,
        getLine: (y) => lineObjs[y] || { translateToString: () => "" },
      },
    },
  };
}

describe("screenFingerprint includes terminal dimensions", () => {
  it("same content at different cols produces different fingerprint", () => {
    const lines = ["hello world", "second line"];
    const term80 = makeMockTerminal(80, 24, 0, 0, lines);
    const term82 = makeMockTerminal(82, 24, 0, 0, lines);

    const fp80 = screenFingerprint(term80);
    const fp82 = screenFingerprint(term82);

    assert.notStrictEqual(
      fp80,
      fp82,
      "fingerprints must differ when cols differ (80 vs 82)"
    );
  });

  it("same content at different rows produces different fingerprint", () => {
    const lines = ["hello world"];
    const term24 = makeMockTerminal(82, 24, 0, 0, lines);
    const term30 = makeMockTerminal(82, 30, 0, 0, lines);

    const fp24 = screenFingerprint(term24);
    const fp30 = screenFingerprint(term30);

    assert.notStrictEqual(
      fp24,
      fp30,
      "fingerprints must differ when rows differ (24 vs 30)"
    );
  });

  it("same dimensions and content produce same fingerprint (deterministic)", () => {
    const lines = ["line one", "line two", "line three"];
    const termA = makeMockTerminal(82, 24, 5, 2, lines);
    const termB = makeMockTerminal(82, 24, 5, 2, lines);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.strictEqual(
      fpA,
      fpB,
      "identical terminals must produce the same fingerprint"
    );
  });

  it("different cursor position produces different fingerprint", () => {
    const lines = ["hello"];
    const termA = makeMockTerminal(82, 24, 0, 0, lines);
    const termB = makeMockTerminal(82, 24, 5, 0, lines);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.notStrictEqual(
      fpA,
      fpB,
      "fingerprints must differ when cursorX differs"
    );

    const termC = makeMockTerminal(82, 24, 0, 0, lines);
    const termD = makeMockTerminal(82, 24, 0, 3, lines);

    const fpC = screenFingerprint(termC);
    const fpD = screenFingerprint(termD);

    assert.notStrictEqual(
      fpC,
      fpD,
      "fingerprints must differ when cursorY differs"
    );
  });

  it("empty terminals at same dimensions have same fingerprint", () => {
    const termA = makeMockTerminal(82, 24);
    const termB = makeMockTerminal(82, 24);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.strictEqual(
      fpA,
      fpB,
      "two empty 82x24 terminals must produce identical fingerprints"
    );
  });

  it("fingerprint is a 32-bit integer (DJB2)", () => {
    const term = makeMockTerminal(82, 24, 3, 5, ["some content here"]);
    const fp = screenFingerprint(term);

    assert.strictEqual(typeof fp, "number", "fingerprint must be a number");
    assert.ok(Number.isFinite(fp), "fingerprint must be finite");
    assert.strictEqual(fp, Math.floor(fp), "fingerprint must be an integer");
    // DJB2 with | 0 produces a signed 32-bit integer
    assert.ok(fp >= -2147483648 && fp <= 2147483647, "fingerprint must be within 32-bit signed range");
  });

  it("different content produces different fingerprint", () => {
    const termA = makeMockTerminal(82, 24, 0, 0, ["hello"]);
    const termB = makeMockTerminal(82, 24, 0, 0, ["world"]);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.notStrictEqual(
      fpA,
      fpB,
      "fingerprints must differ when content differs"
    );
  });
});

describe("screenFingerprint hash order: dims before cursor before content", () => {
  it("swapping cols and rows produces different fingerprint", () => {
    // If cols=80 rows=24 and cols=24 rows=80 produce different hashes,
    // it proves the hash is order-sensitive (not commutative for dims).
    const termA = makeMockTerminal(80, 24);
    const termB = makeMockTerminal(24, 80);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.notStrictEqual(
      fpA,
      fpB,
      "swapping cols and rows must produce different fingerprints"
    );
  });

  it("swapping cursorX and cursorY produces different fingerprint", () => {
    const termA = makeMockTerminal(82, 24, 3, 7);
    const termB = makeMockTerminal(82, 24, 7, 3);

    const fpA = screenFingerprint(termA);
    const fpB = screenFingerprint(termB);

    assert.notStrictEqual(
      fpA,
      fpB,
      "swapping cursorX and cursorY must produce different fingerprints"
    );
  });
});

describe("screenFingerprint matches server algorithm", () => {
  it("client function reproduces the same DJB2 hash as manual calculation", () => {
    // Manually compute the expected DJB2 hash for a known terminal state
    // to verify the algorithm matches what session.js does.
    const cols = 82;
    const rows = 3;
    const cursorX = 2;
    const cursorY = 1;
    const lines = ["abc", "de", ""];

    // Manual DJB2 calculation matching both client and server code:
    let expected = 5381;
    // dims
    expected = ((expected << 5) + expected + cols) | 0;
    expected = ((expected << 5) + expected + rows) | 0;
    // cursor
    expected = ((expected << 5) + expected + cursorY) | 0;
    expected = ((expected << 5) + expected + cursorX) | 0;
    // row content
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        expected = ((expected << 5) + expected + line.charCodeAt(i)) | 0;
      }
    }

    const term = makeMockTerminal(cols, rows, cursorX, cursorY, lines);
    const actual = screenFingerprint(term);

    assert.strictEqual(
      actual,
      expected,
      "screenFingerprint must match manual DJB2 computation"
    );
  });
});
