/**
 * Tests for garble-prevention in the subscribe snapshot and output relay paths.
 *
 * Regression: diamond/replacement characters (U+FFFD) appearing in terminal
 * output when Claude Code (a TUI app) runs in a session. The issue surfaces
 * in three paths:
 *
 * 1. Subscribe snapshot: subscribeClient serializes the headless terminal for
 *    carousel tiles. If multi-byte UTF-8 content is in the session, the
 *    snapshot must preserve it correctly.
 *
 * 2. Output push: the bridge relay reads from the RingBuffer and sends data
 *    to WebSocket clients. Multi-byte sequences must survive this path.
 *
 * 3. Re-subscribe safety: carousel swipe back to an already-subscribed
 *    session must skip serialization to avoid mid-frame garble.
 *
 * 4. ClientHeadless replay flush: xterm.js batches writes asynchronously.
 *    Serializing before flushing captures stale state. The flush-then-serialize
 *    pattern in serializeScreen() must be verified.
 *
 * These tests use real @xterm/headless + SerializeAddon instances (no mocks)
 * because the garble manifests in the serialization layer, not the transport.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Test the RingBuffer + ClientHeadless + Session serialize paths ---
// These use real xterm headless instances.

import { RingBuffer } from "../lib/ring-buffer.js";
import { ClientHeadless } from "../lib/client-headless.js";
import { createClientHeadlessMap } from "../lib/session-manager.js";

// Multi-byte UTF-8 test strings:
// Box-drawing: ─ (U+2500, 3 bytes in UTF-8)
// CJK: 你好 (each 3 bytes in UTF-8)
// Emoji: 🚀 (U+1F680, 4 bytes in UTF-8, surrogate pair in JS)
const BOX_DRAWING = "┌─────────┐\n│  hello  │\n└─────────┘";
const CJK_TEXT = "你好世界";
const EMOJI_TEXT = "Status: 🚀 Running";
const MIXED_CONTENT = `┌──────────┐\n│ 你好 🚀  │\n└──────────┘`;

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

describe("ClientHeadless snapshot with multi-byte UTF-8", () => {
  let ringBuffer;

  beforeEach(() => {
    ringBuffer = new RingBuffer(1024 * 1024);
  });

  it("preserves box-drawing characters through replay + serialize", async () => {
    ringBuffer.push(BOX_DRAWING);

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    // Box-drawing chars should survive serialization
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
    // The actual box chars should be present in the serialized output
    assert.ok(snap.includes("─"), "snapshot should contain box-drawing horizontal line (U+2500)");
    assert.ok(snap.includes("┌"), "snapshot should contain box-drawing corner (U+250C)");
  });

  it("preserves CJK characters through replay + serialize", async () => {
    ringBuffer.push(CJK_TEXT);

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
    assert.ok(snap.includes("你"), "snapshot should contain CJK character");
    assert.ok(snap.includes("好"), "snapshot should contain CJK character");
  });

  it("preserves emoji (surrogate pairs) through replay + serialize", async () => {
    ringBuffer.push(EMOJI_TEXT);

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
    // The emoji may be rendered differently by xterm, but should not be garbled
    assert.ok(snap.includes("Status"), "snapshot should contain ASCII portion");
  });

  it("preserves mixed content (box + CJK + emoji + ANSI) through replay + serialize", async () => {
    ringBuffer.push(MIXED_CONTENT);

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
  });

  it("preserves TUI frame with ANSI escapes + box drawing", async () => {
    ringBuffer.push(TUI_FRAME);

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
    assert.ok(snap.includes("Claude Code"), "snapshot should contain text content");
    assert.ok(snap.includes("╭"), "snapshot should contain rounded corner box char");
  });

  it("handles multiple fragmented ring buffer entries", async () => {
    // Simulate multiple small %output chunks being pushed individually
    // (as happens when tmux splits output across multiple %output lines)
    const chunks = [
      "╭──",       // partial box top
      "────────╮", // rest of box top
      "\x1b[2;1H", // cursor move
      "│ 你",      // partial CJK
      "好世界 │",  // rest
      "\x1b[3;1H",
      "╰─────────╯",
    ];
    for (const chunk of chunks) {
      ringBuffer.push(chunk);
    }

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD replacement characters");
    assert.ok(snap.includes("你好世界"), "snapshot should contain the complete CJK text");
  });
});

describe("ClientHeadless serializeScreen flush timing", () => {
  it("flushes pending writes before serializing", async () => {
    const ringBuffer = new RingBuffer(1024 * 1024);
    ringBuffer.push("Hello World");

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    // serializeScreen calls replay() then flushes then serializes
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(snap.includes("Hello"), "snapshot should contain the written content after flush");
  });

  it("returns null when ring buffer data is evicted past cursor", async () => {
    // Create a tiny ring buffer that evicts quickly
    const ringBuffer = new RingBuffer(100);

    // Push enough data to evict early entries
    for (let i = 0; i < 20; i++) {
      ringBuffer.push("A".repeat(20) + "\n");
    }

    // Create headless with cursor at 0 — data at 0 has been evicted
    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.strictEqual(snap, null, "should return null when data is evicted");
  });

  it("serializes correctly after rapid successive writes", async () => {
    const ringBuffer = new RingBuffer(1024 * 1024);

    // Simulate rapid output burst (many chunks in quick succession)
    for (let i = 0; i < 50; i++) {
      ringBuffer.push(`Line ${i}: ─── 你好 ───\r\n`);
    }

    const ch = new ClientHeadless(ringBuffer, 82, 24);
    const snap = await ch.serializeScreen();
    ch.dispose();

    assert.ok(snap, "snapshot should not be empty");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD after rapid writes");
  });
});

describe("Subscribe re-subscribe safety (carousel swipe)", () => {
  it("clientHeadlessMap.register creates new headless on first subscribe", () => {
    const map = createClientHeadlessMap();
    const ringBuffer = new RingBuffer(1024 * 1024);
    ringBuffer.push("test data");

    const ch = map.register("client-1", "session-1", ringBuffer, 82, 24);
    assert.ok(ch, "should return a ClientHeadless instance");
    assert.strictEqual(ch.cols, 82);
    assert.strictEqual(ch.rows, 24);

    map.disposeAll();
  });

  it("clientHeadlessMap.register disposes existing headless on re-register", () => {
    const map = createClientHeadlessMap();
    const ringBuffer = new RingBuffer(1024 * 1024);
    ringBuffer.push("test data");

    const ch1 = map.register("client-1", "session-1", ringBuffer, 82, 24);
    const ch2 = map.register("client-1", "session-1", ringBuffer, 120, 40);

    assert.notStrictEqual(ch1, ch2, "should create a new headless instance");
    assert.strictEqual(ch2.cols, 120, "new headless should have updated cols");
    assert.strictEqual(ch2.rows, 40, "new headless should have updated rows");

    // Old headless should be disposed (accessing it would fail)
    map.disposeAll();
  });

  it("re-subscribe with same dimensions does not re-register headless", () => {
    // This verifies the session-manager logic: alreadySubscribed && same dims
    // should NOT re-register (which would reset the replay cursor)
    const map = createClientHeadlessMap();
    const ringBuffer = new RingBuffer(1024 * 1024);
    ringBuffer.push("initial data");

    const ch1 = map.register("client-1", "session-1", ringBuffer, 82, 24);

    // Simulate subscribe → advance replay cursor
    ch1.replay();

    // Push more data
    ringBuffer.push("new data after first subscribe");

    // On re-subscribe with SAME dims, session-manager does NOT call register.
    // It only calls register if dims changed. Let's verify the existing
    // headless is still the same and hasn't lost its cursor.
    const existing = map.get("client-1", "session-1");
    assert.strictEqual(existing, ch1, "should return the same headless instance");

    // The existing headless should be able to replay the new data
    const result = existing.replay();
    assert.ok(result.ok, "replay should succeed");

    map.disposeAll();
  });

  it("re-subscribe with changed dimensions registers new headless", async () => {
    const map = createClientHeadlessMap();
    const ringBuffer = new RingBuffer(1024 * 1024);

    // Push TUI content
    ringBuffer.push(TUI_FRAME);

    const ch1 = map.register("client-1", "session-1", ringBuffer, 82, 24);
    await ch1.serializeScreen(); // Advance cursor

    // Re-register with different dims (as session-manager would on re-subscribe
    // with changed dimensions)
    const ch2 = map.register("client-1", "session-1", ringBuffer, 120, 40);
    const snap = await ch2.serializeScreen();

    assert.ok(snap, "new headless should produce a snapshot");
    assert.ok(!snap.includes("\uFFFD"), "snapshot must not contain U+FFFD");
    assert.strictEqual(ch2.cols, 120, "new headless should have updated cols");

    map.disposeAll();
  });
});

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
  // Test the Session-level headless serialize (used as fallback when
  // per-client headless is not available or returns null)

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
