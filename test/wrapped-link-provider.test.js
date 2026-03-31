/**
 * Tests for wrapped-link-provider.js
 *
 * The module uses browser-absolute imports (/lib/...) so we can't import
 * it directly in Node. Instead we inline the pure logic functions
 * (scanBackward, scanForward, offsetToCoord) and the WrappedLinkProvider
 * class, then test them against mock terminal buffers.
 *
 * These tests cover:
 * - Single-line URL detection (baseline)
 * - Soft-wrapped URLs (isWrapped = true)
 * - Hard-wrapped URLs (isWrapped = false, line fills terminal width)
 * - URLs spanning 3+ lines
 * - Edge cases: no false joins across short lines, whitespace boundaries
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inlined logic from wrapped-link-provider.js (mirror kept in sync manually)
// ---------------------------------------------------------------------------

const URL_RE =
  /(https?|HTTPS?):\/\/[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

function scanBackward(buf, y, cols) {
  let startY = y;
  for (let i = y; i > 0 && i > y - 10; i--) {
    const line = buf.getLine(i);
    if (!line) break;
    if (line.isWrapped) {
      startY = i - 1;
      continue;
    }
    const prev = buf.getLine(i - 1);
    if (!prev) break;
    if (prev.translateToString(true).length >= cols) {
      const text = line.translateToString(true);
      if (text.length > 0 && !/^\s/.test(text)) {
        startY = i - 1;
        continue;
      }
    }
    break;
  }
  return startY;
}

function scanForward(buf, y, cols) {
  let endY = y;
  for (let i = y; i < buf.length - 1 && i < y + 10; i++) {
    const next = buf.getLine(i + 1);
    if (!next) break;
    if (next.isWrapped) {
      endY = i + 1;
      continue;
    }
    const curr = buf.getLine(i);
    if (!curr) break;
    if (curr.translateToString(true).length >= cols) {
      const nextText = next.translateToString(true);
      if (nextText.length > 0 && !/^\s/.test(nextText)) {
        endY = i + 1;
        continue;
      }
    }
    break;
  }
  return endY;
}

function offsetToCoord(texts, startY, offset) {
  let rem = offset;
  for (let i = 0; i < texts.length; i++) {
    if (rem < texts[i].length) return { x: rem, y: startY + i };
    rem -= texts[i].length;
  }
  const last = texts.length - 1;
  if (texts[last].length === 0) return null;
  return { x: texts[last].length - 1, y: startY + last };
}

class WrappedLinkProvider {
  constructor(terminal, handler) {
    this._terminal = terminal;
    this._handler = handler || (() => {});
  }

  provideLinks(lineNumber, callback) {
    const buf = this._terminal.buffer.active;
    const cols = this._terminal.cols;
    const y = lineNumber - 1;

    const startY = scanBackward(buf, y, cols);
    const endY = scanForward(buf, y, cols);

    const texts = [];
    for (let i = startY; i <= endY; i++) {
      const line = buf.getLine(i);
      texts.push(line ? line.translateToString(true) : "");
    }

    const joined = texts.join("");
    const re = new RegExp(URL_RE.source, "gi");
    const links = [];
    let m;

    while ((m = re.exec(joined)) !== null) {
      const url = m[0];
      const start = offsetToCoord(texts, startY, m.index);
      const end = offsetToCoord(texts, startY, m.index + url.length - 1);
      if (!start || !end) continue;
      if (start.y > y || end.y < y) continue;

      links.push({
        range: {
          start: { x: start.x + 1, y: start.y + 1 },
          end: { x: end.x + 1, y: end.y + 1 },
        },
        text: url,
      });
    }

    callback(links.length ? links : undefined);
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock terminal buffer from an array of line descriptors.
 * Each descriptor: { text: string, isWrapped?: boolean }
 */
function mockBuffer(lines) {
  return {
    length: lines.length,
    getLine(i) {
      if (i < 0 || i >= lines.length) return null;
      const l = lines[i];
      return {
        isWrapped: l.isWrapped || false,
        translateToString(_trimRight) {
          return _trimRight ? l.text.trimEnd() : l.text;
        },
      };
    },
  };
}

function mockTerminal(lines, cols) {
  return {
    cols,
    buffer: { active: mockBuffer(lines) },
  };
}

/** Helper: run provideLinks and collect results synchronously. */
function getLinks(terminal, lineNumber) {
  const provider = new WrappedLinkProvider(terminal, () => {});
  let result;
  provider.provideLinks(lineNumber, (links) => {
    result = links;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("offsetToCoord", () => {
  it("maps offset within first line", () => {
    const coord = offsetToCoord(["hello world", "next line"], 0, 6);
    assert.deepEqual(coord, { x: 6, y: 0 });
  });

  it("maps offset spanning to second line", () => {
    const coord = offsetToCoord(["hello", "world"], 0, 7);
    assert.deepEqual(coord, { x: 2, y: 1 });
  });

  it("returns null for empty last line", () => {
    const coord = offsetToCoord(["hello", ""], 0, 10);
    assert.equal(coord, null);
  });

  it("respects startY offset", () => {
    const coord = offsetToCoord(["abc", "def"], 5, 4);
    assert.deepEqual(coord, { x: 1, y: 6 });
  });
});

describe("scanBackward", () => {
  it("stays on current line when previous line is short", () => {
    const buf = mockBuffer([
      { text: "short line" },
      { text: "https://example.com" },
    ]);
    assert.equal(scanBackward(buf, 1, 80), 1);
  });

  it("includes previous line when it is soft-wrapped (isWrapped)", () => {
    const buf = mockBuffer([
      { text: "https://example.com/start" },
      { text: "/end/of/path", isWrapped: true },
    ]);
    assert.equal(scanBackward(buf, 1, 80), 0);
  });

  it("includes previous line when it fills terminal width (hard-wrap)", () => {
    // Simulate: line 0 fills 20-col terminal, line 1 continues without isWrapped
    const buf = mockBuffer([
      { text: "https://example.com/" }, // exactly 20 chars = cols
      { text: "path/to/resource" },     // no isWrapped (tmux redraw)
    ]);
    assert.equal(scanBackward(buf, 1, 20), 0);
  });

  it("stops when continuation line starts with whitespace", () => {
    const buf = mockBuffer([
      { text: "x".repeat(80) },
      { text: " indented text" },
    ]);
    assert.equal(scanBackward(buf, 1, 80), 1);
  });
});

describe("scanForward", () => {
  it("stays on current line when it is short", () => {
    const buf = mockBuffer([
      { text: "https://example.com" },
      { text: "next line" },
    ]);
    assert.equal(scanForward(buf, 0, 80), 0);
  });

  it("includes next line when it is soft-wrapped", () => {
    const buf = mockBuffer([
      { text: "https://example.com/start" },
      { text: "/end", isWrapped: true },
    ]);
    assert.equal(scanForward(buf, 0, 80), 1);
  });

  it("includes next line when current fills terminal width (hard-wrap)", () => {
    const buf = mockBuffer([
      { text: "https://example.com/" }, // 20 chars = cols
      { text: "long/path/continues" },
    ]);
    assert.equal(scanForward(buf, 0, 20), 1);
  });

  it("stops when next line starts with whitespace", () => {
    const buf = mockBuffer([
      { text: "x".repeat(80) },
      { text: " indented" },
    ]);
    assert.equal(scanForward(buf, 0, 80), 0);
  });
});

describe("WrappedLinkProvider", () => {
  it("detects a single-line URL", () => {
    const term = mockTerminal(
      [{ text: "visit https://example.com/page for info" }],
      80,
    );
    const links = getLinks(term, 1);
    assert.ok(links, "should find a link");
    assert.equal(links.length, 1);
    assert.equal(links[0].text, "https://example.com/page");
    // Entire link is on line 1
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 1);
  });

  it("detects a URL wrapped via isWrapped (soft-wrap)", () => {
    // URL: https://example.com/very/long/path
    // Line 0 (30 cols): "see https://example.com/very/l"  (30 chars)
    // Line 1 (wrapped): "ong/path done"
    const term = mockTerminal(
      [
        { text: "see https://example.com/very/l" },
        { text: "ong/long/path done", isWrapped: true },
      ],
      30,
    );

    // Click on line 1 (the wrapped continuation)
    const links = getLinks(term, 2);
    assert.ok(links, "should find a link on line 2");
    assert.equal(links[0].text, "https://example.com/very/long/long/path");
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 2);

    // Click on line 0 (the start of the URL)
    const links0 = getLinks(term, 1);
    assert.ok(links0, "should find a link on line 1");
    assert.equal(links0[0].text, "https://example.com/very/long/long/path");
  });

  it("detects a URL wrapped by tmux hard-wrap (no isWrapped)", () => {
    // Simulates tmux redraw: line fills terminal width but isWrapped is false.
    // Terminal is 30 columns wide.
    const cols = 30;
    const term = mockTerminal(
      [
        { text: "https://example.com/aaa/bbb/cc" }, // exactly 30 chars = cols
        { text: "c/ddd/eee end" },                   // continuation, no isWrapped
      ],
      cols,
    );

    // Click on line 2 (the continuation)
    const links = getLinks(term, 2);
    assert.ok(links, "should detect wrapped URL on line 2");
    assert.equal(links[0].text, "https://example.com/aaa/bbb/ccc/ddd/eee");
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 2);

    // Click on line 1 (the start)
    const links1 = getLinks(term, 1);
    assert.ok(links1, "should detect wrapped URL on line 1");
    assert.equal(links1[0].text, "https://example.com/aaa/bbb/ccc/ddd/eee");
  });

  it("detects a URL spanning 3 lines (hard-wrapped)", () => {
    const cols = 20;
    const term = mockTerminal(
      [
        { text: "https://example.com/" }, // 20 chars = cols
        { text: "path/to/a/very/long/" }, // 20 chars = cols
        { text: "resource end" },
      ],
      cols,
    );

    // Click on the middle line
    const links = getLinks(term, 2);
    assert.ok(links, "should find the link from middle line");
    assert.equal(links[0].text, "https://example.com/path/to/a/very/long/resource");
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 3);
  });

  it("does not join lines when the previous line is short", () => {
    const term = mockTerminal(
      [
        { text: "short" },               // 5 chars < 80 cols
        { text: "https://example.com" },
      ],
      80,
    );

    const links = getLinks(term, 2);
    assert.ok(links);
    assert.equal(links[0].text, "https://example.com");
    // Should be entirely on line 2
    assert.equal(links[0].range.start.y, 2);
    assert.equal(links[0].range.end.y, 2);
  });

  it("does not join lines when continuation starts with whitespace", () => {
    const cols = 30;
    const term = mockTerminal(
      [
        { text: "https://example.com/aaaa/bbbbb" }, // 30 chars = cols
        { text: " next paragraph" },                 // starts with space
      ],
      cols,
    );

    const links = getLinks(term, 1);
    assert.ok(links);
    assert.equal(links[0].text, "https://example.com/aaaa/bbbbb");
    assert.equal(links[0].range.start.y, 1);
    assert.equal(links[0].range.end.y, 1);
  });

  it("returns undefined when no URLs are present", () => {
    const term = mockTerminal([{ text: "no links here" }], 80);
    const links = getLinks(term, 1);
    assert.equal(links, undefined);
  });

  it("detects multiple URLs on the same line", () => {
    const term = mockTerminal(
      [{ text: "see https://a.com and https://b.com ok" }],
      80,
    );
    const links = getLinks(term, 1);
    assert.ok(links);
    assert.equal(links.length, 2);
    assert.equal(links[0].text, "https://a.com");
    assert.equal(links[1].text, "https://b.com");
  });
});
