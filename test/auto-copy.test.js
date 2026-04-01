/**
 * Tests for auto-copy on selection.
 *
 * Verifies that onSelectionChange copies non-empty selections to the system
 * clipboard via navigator.clipboard.writeText, and silently ignores failures.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Minimal reimplementation of the auto-copy wiring from app.js.
 * Mirrors the real onTerminalCreated callback so we can test the contract
 * without pulling in browser-only imports.
 */
function wireAutoCopy(term) {
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text) {
      const stripped = text.split("\n").map(l => l.trimEnd()).join("\n");
      navigator.clipboard.writeText(stripped).catch(() => {});
    }
  });
}

describe("auto-copy on selection", () => {
  let selectionCb;
  let term;
  let writeTextMock;

  beforeEach(() => {
    selectionCb = null;
    writeTextMock = mock.fn(() => Promise.resolve());

    term = {
      onSelectionChange: (cb) => { selectionCb = cb; },
      getSelection: () => "",
    };

    // Provide navigator.clipboard globally for the test.
    // In Node, `navigator` is a read-only getter so we must use defineProperty.
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: writeTextMock } },
      writable: true,
      configurable: true,
    });
  });

  it("copies non-empty selection to clipboard", () => {
    wireAutoCopy(term);
    term.getSelection = () => "hello world";
    selectionCb();
    assert.equal(writeTextMock.mock.calls.length, 1);
    assert.deepStrictEqual(writeTextMock.mock.calls[0].arguments, ["hello world"]);
  });

  it("does not copy when selection is empty", () => {
    wireAutoCopy(term);
    term.getSelection = () => "";
    selectionCb();
    assert.equal(writeTextMock.mock.calls.length, 0);
  });

  it("silently ignores clipboard write failures", async () => {
    writeTextMock = mock.fn(() => Promise.reject(new Error("denied")));
    globalThis.navigator.clipboard.writeText = writeTextMock;

    wireAutoCopy(term);
    term.getSelection = () => "some text";
    selectionCb();

    // The .catch(() => {}) swallows the error — just verify writeText was called
    assert.equal(writeTextMock.mock.calls.length, 1);
    // Allow the microtask to settle without throwing
    await new Promise((r) => setTimeout(r, 10));
  });

  it("strips trailing spaces from each line (wrapped text)", () => {
    wireAutoCopy(term);
    // Simulate xterm padding each wrapped line to full column width (80 cols)
    term.getSelection = () => "https://example.com/a112     \nd9d16e   ";
    selectionCb();
    assert.equal(writeTextMock.mock.calls.length, 1);
    assert.deepStrictEqual(
      writeTextMock.mock.calls[0].arguments,
      ["https://example.com/a112\nd9d16e"],
    );
  });

  it("does not copy when selection is null/undefined", () => {
    wireAutoCopy(term);
    term.getSelection = () => null;
    selectionCb();
    assert.equal(writeTextMock.mock.calls.length, 0);

    term.getSelection = () => undefined;
    selectionCb();
    assert.equal(writeTextMock.mock.calls.length, 0);
  });
});
