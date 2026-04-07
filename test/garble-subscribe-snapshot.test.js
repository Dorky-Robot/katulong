/**
 * Tests for garble-prevention in the subscribe snapshot and output relay paths.
 *
 * Regression: diamond/replacement characters (U+FFFD) appearing in terminal
 * output when Claude Code (a TUI app) runs in a session. The issue surfaces
 * in two paths that survived PCH-7:
 *
 * 1. Output push: the bridge relay reads from the RingBuffer and sends data
 *    to WebSocket clients. Multi-byte sequences must survive this path.
 *
 * 2. Session headless serialize: attach/subscribe/resync/pull-snapshot all
 *    call session.serializeScreen() (the shared headless). Multi-byte
 *    content must survive serialization.
 *
 * (Historical: this file also tested ClientHeadless replay, but PCH-7
 * deleted that module. See commit message for the architectural rationale.)
 *
 * These tests use real @xterm/headless + SerializeAddon instances (no mocks)
 * because the garble manifests in the serialization layer, not the transport.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RingBuffer } from "../lib/ring-buffer.js";

// Multi-byte UTF-8 test strings:
// Box-drawing: ─ (U+2500, 3 bytes in UTF-8)
// CJK: 你好 (each 3 bytes in UTF-8)
// Emoji: 🚀 (U+1F680, 4 bytes in UTF-8, surrogate pair in JS)

// Claude Code-style TUI content with ANSI escapes + box drawing
const TUI_FRAME = [
  "\x1b[1;1H",           // cursor home
  "\x1b[38;5;39m",       // blue foreground
  "╭─────────────────╮",
  "\x1b[2;1H",
  "│ Claude Code     │",
  "\x1b[3;1H",
  "╰─────────────────╯",
  "\x1b[0m",             // reset
].join("");

describe("RingBuffer sliceFrom with multi-byte content", () => {
  it("sliceFrom at item boundary preserves multi-byte characters", () => {
    const rb = new RingBuffer(1024 * 1024);
    rb.push("Hello "); // 6 chars
    const boundary = rb.totalBytes;
    rb.push("你好世界"); // 4 chars (each is 1 JS code unit for BMP)

    const slice = rb.sliceFrom(boundary);
    assert.strictEqual(slice, "你好世界", "sliceFrom at item boundary should preserve CJK");
  });

  it("sliceFrom at item boundary preserves emoji surrogate pairs", () => {
    const rb = new RingBuffer(1024 * 1024);
    rb.push("Status: "); // 8 chars
    const boundary = rb.totalBytes;
    rb.push("🚀 Done"); // emoji is 2 JS code units (surrogate pair)

    const slice = rb.sliceFrom(boundary);
    assert.strictEqual(slice, "🚀 Done", "sliceFrom at item boundary should preserve emoji");
  });

  it("sliceFrom within an item does not split surrogate pairs", () => {
    const rb = new RingBuffer(1024 * 1024);
    // Push a string with emoji: "A🚀B" = 4 code units: 'A' + high surrogate + low surrogate + 'B'
    const testStr = "A🚀B";
    assert.strictEqual(testStr.length, 4, "test string should be 4 code units (surrogate pair)");
    rb.push(testStr);

    // Try to slice from offset 1 (after 'A') — this should get "🚀B"
    const slice = rb.sliceFrom(1);
    // If sliceFrom uses string.slice(1), this gets the full emoji + 'B'
    // because JS string.slice operates on code units, and offset 1 puts us
    // at the start of the high surrogate
    assert.ok(slice !== null, "sliceFrom should not return null");
    assert.ok(!slice.includes("\uFFFD"), "sliceFrom must not produce U+FFFD from split surrogate");
  });

  it("sliceFrom adjusts backwards to avoid splitting surrogate pairs", () => {
    const rb = new RingBuffer(1024 * 1024);
    // "A🚀B" — code units: A (0x41), 0xD83D (high), 0xDE80 (low), B (0x42)
    rb.push("A🚀B");

    // Slice from offset 2 — this would land on the LOW surrogate of the emoji.
    // Without the surrogate-pair guard, string.slice(2) produces a string starting
    // with 0xDE80 (lone low surrogate) → U+FFFD replacement character in xterm.js.
    // The fix adjusts skipBytes backwards to include the full surrogate pair.
    const slice = rb.sliceFrom(2);
    assert.ok(slice !== null, "sliceFrom should not return null");

    // Verify no lone surrogates in the result
    const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(slice);
    assert.ok(!hasLoneSurrogate, "sliceFrom must not produce lone surrogates from split emoji");

    // The result should include the full emoji
    assert.ok(slice.includes("🚀"), "result should include the full emoji (adjusted back to include high surrogate)");
    assert.ok(slice.includes("B"), "result should include trailing content");
  });

  it("totalBytes tracks JS string length (code units), not UTF-8 bytes", () => {
    const rb = new RingBuffer(1024 * 1024);
    // "🚀" is 4 UTF-8 bytes but 2 JS code units
    rb.push("🚀");
    assert.strictEqual(rb.totalBytes, 2, "totalBytes should be JS string length (2), not UTF-8 byte count (4)");
  });
});

describe("Output relay path with multi-byte content", () => {
  it("coalesced output from RingBuffer preserves multi-byte sequences", () => {
    const rb = new RingBuffer(1024 * 1024);

    // Simulate multiple %output chunks being pushed rapidly
    const fromSeq = rb.totalBytes;
    rb.push("╭──────╮\n");
    rb.push("│ 你好 │\n");
    rb.push("╰──────╯\n");

    // This is what notifyDataAvailable does:
    const data = rb.sliceFrom(fromSeq);

    assert.ok(data, "data should not be null");
    assert.ok(!data.includes("\uFFFD"), "coalesced output must not contain U+FFFD");
    assert.ok(data.includes("你好"), "coalesced output should preserve CJK");
    assert.ok(data.includes("╭"), "coalesced output should preserve box-drawing");
  });

  it("bridge relay data from sliceFrom is valid for JSON serialization", () => {
    const rb = new RingBuffer(1024 * 1024);

    const fromSeq = rb.totalBytes;
    rb.push(TUI_FRAME);

    const data = rb.sliceFrom(fromSeq);

    // Simulate what ws-manager does: JSON.stringify the data
    const encoded = JSON.stringify({
      type: "output",
      session: "test",
      data,
      fromSeq,
      cursor: rb.totalBytes,
    });

    // Parse it back
    const decoded = JSON.parse(encoded);
    assert.strictEqual(decoded.data, data, "JSON round-trip should preserve data exactly");
    assert.ok(!decoded.data.includes("\uFFFD"), "JSON-encoded data must not contain U+FFFD");
  });
});

describe("Session headless serialize with multi-byte content", () => {
  // Test the Session-level headless serialize (the only snapshot source after
  // PCH-7 — attach/subscribe/resync/pull-snapshot all call this).

  it("Session.serializeScreen preserves multi-byte content", async () => {
    // We can't easily import Session without mocking tmux, so test
    // the underlying pattern: headless terminal + SerializeAddon
    const xtermHeadless = await import("@xterm/headless");
    const xtermSerialize = await import("@xterm/addon-serialize");
    const { Terminal } = xtermHeadless.default || xtermHeadless;
    const { SerializeAddon } = xtermSerialize.default || xtermSerialize;

    const headless = new Terminal({ cols: 82, rows: 24, scrollback: 200, allowProposedApi: true });
    const serializeAddon = new SerializeAddon();
    headless.loadAddon(serializeAddon);

    // Write multi-byte content
    await new Promise(resolve => headless.write(TUI_FRAME, resolve));

    // Flush and serialize (same pattern as Session.serializeScreen)
    await new Promise(resolve => headless.write("", resolve));
    const snap = serializeAddon.serialize();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "serialized snapshot must not contain U+FFFD");
    assert.ok(snap.includes("Claude Code"), "snapshot should contain text content");

    headless.dispose();
  });

  it("SerializeAddon handles rapid write + serialize correctly", async () => {
    const xtermHeadless = await import("@xterm/headless");
    const xtermSerialize = await import("@xterm/addon-serialize");
    const { Terminal } = xtermHeadless.default || xtermHeadless;
    const { SerializeAddon } = xtermSerialize.default || xtermSerialize;

    const headless = new Terminal({ cols: 82, rows: 24, scrollback: 200, allowProposedApi: true });
    const serializeAddon = new SerializeAddon();
    headless.loadAddon(serializeAddon);

    // Write multiple rapid frames (simulating Claude Code updating)
    for (let i = 0; i < 10; i++) {
      headless.write(`\x1b[1;1H╭── Frame ${i} ──╮`);
      headless.write(`\x1b[2;1H│ 你好世界 🚀  │`);
      headless.write(`\x1b[3;1H╰──────────────╯`);
    }

    // Flush and serialize
    await new Promise(resolve => headless.write("", resolve));
    const snap = serializeAddon.serialize();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot after rapid frames must not contain U+FFFD");

    headless.dispose();
  });
});
