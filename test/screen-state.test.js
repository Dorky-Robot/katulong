/**
 * Tests for the ScreenState abstraction extracted from Session in Tier 3.1.
 *
 * ScreenState is the server-side mirror of a terminal's visible state. It
 * wraps a headless `@xterm/headless` Terminal plus the SerializeAddon and
 * tracks the current dimensions. The contract this test pins:
 *
 *   - dimensions update via resize() and are observable via cols/rows
 *   - write() / seed() reach the underlying mirror
 *   - serialize() and computeHash() return non-trivial values for non-empty
 *     content and zero/empty values once disposed
 *   - dispose() is idempotent and turns every mutator into a no-op
 *   - flush() returns false after dispose so callers can bail safely
 *
 * The Lamport-style { hash, seq } pairing lives on Session, NOT here —
 * ScreenState owns no concept of byte-stream sequence on purpose.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScreenState } from "../lib/screen-state.js";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT } from "../lib/terminal-config.js";

describe("ScreenState", () => {
  describe("construction", () => {
    it("starts at the configured default dimensions", () => {
      const screen = new ScreenState();
      assert.strictEqual(screen.cols, DEFAULT_COLS);
      assert.strictEqual(screen.rows, TERMINAL_ROWS_DEFAULT);
      assert.strictEqual(screen.disposed, false);
      screen.dispose();
    });

    it("exposes the underlying xterm Terminal for parity tests", () => {
      const screen = new ScreenState();
      assert.ok(screen.term, "term getter should expose the Terminal");
      assert.strictEqual(typeof screen.term.write, "function");
      screen.dispose();
    });
  });

  describe("resize", () => {
    it("updates cols and rows in lockstep with the underlying mirror", () => {
      const screen = new ScreenState();
      screen.resize(120, 40);
      assert.strictEqual(screen.cols, 120);
      assert.strictEqual(screen.rows, 40);
      assert.strictEqual(screen.term.cols, 120,
        "underlying xterm dimensions must match — fingerprint hashes them");
      assert.strictEqual(screen.term.rows, 40);
      screen.dispose();
    });

    it("is a no-op once disposed", () => {
      const screen = new ScreenState();
      screen.dispose();
      // Must not throw — deferred timer paths can race a kill
      screen.resize(80, 24);
      assert.strictEqual(screen.disposed, true);
    });
  });

  describe("seed", () => {
    it("writes captured pane content into the mirror", async () => {
      const screen = new ScreenState();
      await screen.seed("$ hello world\r\n$ ");
      const serialized = await screen.serialize();
      assert.ok(serialized.includes("hello world"),
        "serialize() must reflect seeded content");
      screen.dispose();
    });

    it("positions the cursor when cursorPos is provided (1-based input)", async () => {
      const screen = new ScreenState();
      await screen.seed("line1\r\nline2\r\nline3", { row: 2, col: 5 });
      // cursor coords are 0-based; row/col were 1-based
      const { x, y } = screen.cursor;
      assert.strictEqual(y, 1, "cursor row should be 1 (0-based) for row:2");
      assert.strictEqual(x, 4, "cursor col should be 4 (0-based) for col:5");
      screen.dispose();
    });

    it("no-ops when content is null or empty", async () => {
      const screen = new ScreenState();
      // Both must complete without throwing
      await screen.seed(null);
      await screen.seed("");
      screen.dispose();
    });

    it("no-ops when disposed", async () => {
      const screen = new ScreenState();
      screen.dispose();
      // Must not throw — Session.seedScreen relies on this for safe shutdown
      await screen.seed("anything", { row: 1, col: 1 });
    });
  });

  describe("flush", () => {
    it("returns true while alive, false after dispose", async () => {
      const screen = new ScreenState();
      assert.strictEqual(await screen.flush(), true);
      screen.dispose();
      assert.strictEqual(await screen.flush(), false,
        "callers (Session.screenFingerprint) bail on false to avoid hashing " +
        "a disposed mirror");
    });
  });

  describe("serialize", () => {
    it("returns escape sequences for the mirrored content", async () => {
      const screen = new ScreenState();
      screen.write("hello");
      const serialized = await screen.serialize();
      assert.strictEqual(typeof serialized, "string");
      assert.ok(serialized.length > 0, "serialize must include the written text");
      assert.ok(serialized.includes("hello"));
      screen.dispose();
    });

    it("returns empty string when disposed", async () => {
      const screen = new ScreenState();
      screen.dispose();
      assert.strictEqual(await screen.serialize(), "");
    });

    it("returns empty string without throwing when disposed mid-flush", async () => {
      // Regression: after `await this.flush()` returns true, a concurrent
      // dispose() can null `this._term` before we reach the _core access
      // in the DECSTBM path. Without a post-await null guard on `term`,
      // this races into a TypeError. Simulate by kicking off serialize()
      // and disposing synchronously before the microtask resolves.
      const screen = new ScreenState();
      screen.write("some content");
      const promise = screen.serialize();
      screen.dispose();
      const result = await promise;
      assert.strictEqual(result, "",
        "serialize() must resolve to '' (not throw) if dispose races the flush");
    });

    it("appends DECSTBM when the active buffer has a non-default scroll region", async () => {
      // Regression: SerializeAddon does not emit DECSTBM, so TUI apps that
      // pin a footer via scroll margins (notably Claude Code) lose the region
      // on attach/subscribe/resync replay, and subsequent streaming writes
      // scroll the pinned footer out of view. ScreenState.serialize() must
      // append a cursor-safe DECSTBM so the client xterm re-establishes the
      // region on whichever buffer SerializeAddon landed on.
      const screen = new ScreenState();
      screen.resize(40, 10);
      // Enter alt-screen (Claude Code's case), set region rows 1..7,
      // put content in the region and in the pinned footer.
      screen.write("\x1b[?1049h\x1b[1;7r\x1b[1;1Hregion\x1b[8;1Hfooter");
      const out = await screen.serialize();
      assert.match(out, /\x1b\[1;7r/, "must emit DECSTBM for rows 1..7");
      // Cursor save/restore dance must wrap the DECSTBM so cursor position
      // from SerializeAddon's tail is preserved (DECSTBM homes the cursor).
      assert.ok(out.includes("\x1b7") && out.includes("\x1b8"),
        "DECSTBM must be wrapped in DECSC/DECRC to preserve cursor");
      screen.dispose();
    });

    it("preserves pinned footer across replay + scrolling writes (Claude TUI repro)", async () => {
      // End-to-end regression for the "bottom rows overwritten in Claude TUI"
      // bug: Claude Code enters alt-screen, sets a scroll region above its
      // pinned footer, and streams content into the region. If the replay
      // loses DECSTBM, scrolling writes push the footer out. This test
      // simulates the exact flow: source terminal sets up the scene, we
      // serialize, replay into a second headless (the "client"), then push
      // scroll-inducing writes into the region and assert the footer rows
      // are untouched.
      const { ScreenState: _SS } = await import("../lib/screen-state.js");
      const src = new _SS();
      src.resize(40, 10);
      // Alt-screen, region rows 1..7, content in region, "footer" at rows 8-9.
      src.write("\x1b[?1049h\x1b[1;7r\x1b[1;1Hregion-content\x1b[8;1HFOOTER-A\x1b[9;1HFOOTER-B");
      const snapshot = await src.serialize();

      // Replay into a fresh ScreenState playing the role of the client.
      const dst = new _SS();
      dst.resize(40, 10);
      dst.write(snapshot);
      await dst.flush();
      // Verify the region was re-established on the destination's active buffer.
      const dBuf = dst.term._core.buffers.active;
      assert.strictEqual(dBuf.scrollTop, 0, "destination scrollTop must match source (row 0)");
      assert.strictEqual(dBuf.scrollBottom, 6, "destination scrollBottom must match source (row 6)");

      // Now push scroll-inducing writes from the bottom of the region.
      // With DECSTBM intact, these scroll the region internally and leave
      // rows 7-8 (0-indexed; "FOOTER-A"/"FOOTER-B") untouched. Without the
      // fix, the footer gets scrolled up and overwritten.
      dst.write("\x1b[7;1H"); // bottom of region (row 7 1-indexed)
      for (let i = 0; i < 10; i++) dst.write(`streaming-line-${i}\n`);
      await dst.flush();

      // Use the public buffer API (term.buffer.active) for reading lines —
      // _core.buffers.active is the internal shape used for scrollTop/Bottom
      // but getLine() lives on the public wrapper.
      const pubBuf = dst.term.buffer.active;
      const footerA = pubBuf.getLine(pubBuf.baseY + 7).translateToString(true);
      const footerB = pubBuf.getLine(pubBuf.baseY + 8).translateToString(true);
      assert.strictEqual(footerA, "FOOTER-A",
        "pinned footer row A must survive scrolling inside the region");
      assert.strictEqual(footerB, "FOOTER-B",
        "pinned footer row B must survive scrolling inside the region");

      src.dispose();
      dst.dispose();
    });

    it("does not append DECSTBM when scroll region is default", async () => {
      const screen = new ScreenState();
      screen.write("plain content");
      const out = await screen.serialize();
      // No DECSTBM when region is the full screen — avoid emitting a noop
      // that would still cost the client a parser round-trip.
      assert.doesNotMatch(out, /\x1b\[\d+;\d+r/,
        "default scroll region must not emit DECSTBM");
      screen.dispose();
    });
  });

  describe("computeHash", () => {
    it("returns a non-zero hash after content is written", async () => {
      const screen = new ScreenState();
      screen.write("anything");
      await screen.flush();
      const hash = screen.computeHash();
      assert.strictEqual(typeof hash, "number");
      assert.notStrictEqual(hash, 0,
        "DJB2 of dimensions+cursor+content must be non-zero for non-empty content");
      screen.dispose();
    });

    it("changes when dimensions change (dims are part of the hash)", async () => {
      const screen = new ScreenState();
      screen.write("padded text");
      await screen.flush();
      const before = screen.computeHash();
      screen.resize(120, 30);
      await screen.flush();
      const after = screen.computeHash();
      assert.notStrictEqual(before, after,
        "dimensions must hash differently — drift detection compares dims " +
        "between client and server fingerprints");
      screen.dispose();
    });

    it("returns 0 when disposed", () => {
      const screen = new ScreenState();
      screen.dispose();
      assert.strictEqual(screen.computeHash(), 0);
    });
  });

  describe("cursor", () => {
    it("returns null after dispose", () => {
      const screen = new ScreenState();
      screen.dispose();
      assert.strictEqual(screen.cursor, null);
    });
  });

  describe("dispose", () => {
    it("is idempotent — second dispose does not throw", () => {
      const screen = new ScreenState();
      screen.dispose();
      screen.dispose();
      assert.strictEqual(screen.disposed, true);
    });

    it("makes write() a no-op", () => {
      const screen = new ScreenState();
      screen.dispose();
      screen.write("anything");
      // No assertion — the contract is "does not throw"
    });
  });
});
