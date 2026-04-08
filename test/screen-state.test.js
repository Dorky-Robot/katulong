/**
 * Tests for the ScreenState abstraction — the server-side mirror of a
 * terminal's visible state.
 *
 * Raptor 3 made ScreenState the sole source of truth for "what the terminal
 * looks like right now". Drift detection (computeHash) was deleted because
 * Raptor 3 flows every dim change through an atomic `snapshot` message, so
 * the client is guaranteed to be at matching dims by construction — there
 * is nothing left to compare between. The contract this test pins:
 *
 *   - dimensions update via resize() and are observable via cols/rows
 *   - write() / seed() reach the underlying mirror
 *   - serialize() returns escape sequences for non-empty content and an
 *     empty string once disposed
 *   - dispose() is idempotent and turns every mutator into a no-op
 *   - flush() returns false after dispose so callers can bail safely
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
        "underlying xterm dims must match — serialize() walks this grid");
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
        "callers (Session._applyResize) bail on false so a deferred " +
        "resize racing a dispose does not throw");
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
