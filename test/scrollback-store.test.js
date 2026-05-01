/**
 * Scrollback Store Tests
 *
 * Tests per-session terminal-history persistence: write-on-shutdown,
 * read-on-restore, atomic temp+rename, file mode, id validation,
 * and orphan pruning.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, readFileSync, existsSync, openSync, ftruncateSync, closeSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createScrollbackStore } from "../lib/scrollback-store.js";

let dataDir;
let store;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kat-scrollback-"));
  store = createScrollbackStore({ dataDir });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("scrollback store", () => {
  describe("save / load round trip", () => {
    it("persists data and cursor and reads them back identically", () => {
      const data = "\x1b[2J\x1b[H$ ls\nfile1\nfile2\n";
      store.save("session_id_abc", data, 12345);

      const loaded = store.load("session_id_abc");
      assert.deepStrictEqual(loaded, { data, cursor: 12345 });
    });

    it("survives terminal output containing newlines and control bytes", () => {
      // The line-prefix format splits on the FIRST newline only; data after
      // that may contain arbitrary bytes including more newlines and the
      // 0x1B ESC byte that fills terminal output.
      const data = "line1\nline2\n\x1b[31mred\x1b[0m\n\x00\x07\x1b[H";
      store.save("session_id_xyz", data, data.length);

      const loaded = store.load("session_id_xyz");
      assert.strictEqual(loaded.data, data);
      assert.strictEqual(loaded.cursor, data.length);
    });

    it("handles an empty buffer (session with totalBytes > 0 but fully evicted)", () => {
      store.save("session_id_evicted", "", 999999);

      const loaded = store.load("session_id_evicted");
      assert.deepStrictEqual(loaded, { data: "", cursor: 999999 });
    });

    it("returns null for a session with no saved scrollback", () => {
      assert.strictEqual(store.load("never_saved_id"), null);
    });
  });

  describe("input validation", () => {
    it("save rejects path-traversing ids without writing", () => {
      store.save("../escape", "data", 4);
      store.save("a/b", "data", 4);
      store.save("with.dots", "data", 4);

      // Nothing should land in the scrollback dir.
      const entries = readdirSync(join(dataDir, "scrollback"));
      assert.deepStrictEqual(entries, []);
    });

    it("load rejects bad ids without reading", () => {
      assert.strictEqual(store.load("../escape"), null);
      assert.strictEqual(store.load(""), null);
      assert.strictEqual(store.load(null), null);
      assert.strictEqual(store.load(123), null);
    });

    it("save rejects non-string data and bad cursors", () => {
      store.save("session_id_a", null, 100);
      store.save("session_id_a", "data", -1);
      store.save("session_id_a", "data", NaN);
      // Cursor smaller than data.length is structurally inconsistent.
      store.save("session_id_a", "hello world", 3);

      const entries = readdirSync(join(dataDir, "scrollback"));
      assert.deepStrictEqual(entries, []);
    });

    it("load returns null on a corrupt file (missing newline header)", () => {
      // Hand-write a file with no header newline. Should be rejected, not
      // crash the restore path.
      writeFileSync(join(dataDir, "scrollback", "corrupt_id"), "no header here");

      assert.strictEqual(store.load("corrupt_id"), null);
    });

    it("load returns null on a non-numeric cursor", () => {
      writeFileSync(join(dataDir, "scrollback", "bad_cursor_id"), "not_a_number\nactual data");

      assert.strictEqual(store.load("bad_cursor_id"), null);
    });

    it("load returns null on a non-integer cursor", () => {
      writeFileSync(join(dataDir, "scrollback", "fractional_id"), "1.5\nactual data");

      assert.strictEqual(store.load("fractional_id"), null);
    });

    it("load returns null when cursor < data.length (truncated header)", () => {
      writeFileSync(join(dataDir, "scrollback", "truncated_id"), "5\nthis_is_definitely_more_than_5_chars");

      assert.strictEqual(store.load("truncated_id"), null);
    });

    it("load refuses files larger than the RingBuffer cap (OOM defense)", () => {
      // The store rejects anything > 20 MB + small slack. We simulate a
      // tampered/oversized file without actually writing 21 MB by truncating
      // a sparse file (stat.size reports the truncated size and triggers
      // the gate before readFileSync runs).
      const oversizePath = join(dataDir, "scrollback", "oversize_id");
      const fd = openSync(oversizePath, "w");
      try {
        ftruncateSync(fd, 25 * 1024 * 1024); // 25 MB sparse file
      } finally {
        closeSync(fd);
      }

      assert.strictEqual(store.load("oversize_id"), null,
        "oversized file must be refused before readFileSync runs");
    });
  });

  describe("atomic write", () => {
    it("writes via temp + rename, leaving no .tmp file on success", () => {
      store.save("session_id_atomic", "data", 4);

      const entries = readdirSync(join(dataDir, "scrollback"));
      assert.deepStrictEqual(entries, ["session_id_atomic"]);
    });

    it("file is mode 0o600 (owner-only — terminal output may contain secrets)", () => {
      store.save("session_id_perms", "data", 4);

      const filePath = join(dataDir, "scrollback", "session_id_perms");
      const mode = statSync(filePath).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    });

    it("save replaces existing file in place (cursor advances on restart)", () => {
      store.save("session_id_replace", "old data", 8);
      store.save("session_id_replace", "new data with more bytes", 100);

      const loaded = store.load("session_id_replace");
      assert.strictEqual(loaded.data, "new data with more bytes");
      assert.strictEqual(loaded.cursor, 100);
    });
  });

  describe("remove", () => {
    it("deletes the scrollback file for a session", () => {
      store.save("session_id_doomed", "data", 4);
      assert.notStrictEqual(store.load("session_id_doomed"), null);

      store.remove("session_id_doomed");
      assert.strictEqual(store.load("session_id_doomed"), null);
    });

    it("is a no-op for a session with no saved file", () => {
      // Should not throw.
      store.remove("never_saved_id");
    });
  });

  describe("pruneExcept", () => {
    it("removes scrollback files for ids not in the active set", () => {
      store.save("active_a", "a", 1);
      store.save("active_b", "b", 1);
      store.save("orphan_c", "c", 1);
      store.save("orphan_d", "d", 1);

      store.pruneExcept(["active_a", "active_b"]);

      const remaining = readdirSync(join(dataDir, "scrollback")).sort();
      assert.deepStrictEqual(remaining, ["active_a", "active_b"]);
    });

    it("preserves recent .tmp.<pid> files (a concurrent write may own them)", () => {
      // Simulate a temp file from a live writer in another process.
      writeFileSync(join(dataDir, "scrollback", "session_x.tmp.99999"), "in-flight");

      store.pruneExcept([]);

      // Recent tmp file is preserved — pruning would race the other writer.
      assert.ok(existsSync(join(dataDir, "scrollback", "session_x.tmp.99999")));
    });

    it("evicts stale .tmp.<pid> files older than the age threshold", () => {
      // A repeatedly crashing server can otherwise accumulate 20 MB-sized
      // temp files indefinitely. Anything older than the threshold belongs
      // to a writer whose pid is long gone.
      const stalePath = join(dataDir, "scrollback", "session_y.tmp.88888");
      writeFileSync(stalePath, "stranded");
      // Backdate the file 2 hours (well past the 1-hour threshold).
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

      store.pruneExcept([]);

      assert.ok(!existsSync(stalePath), "stale .tmp file must be evicted");
    });

    it("preserves files whose names don't match the id format (.gitkeep, dotfiles, etc.)", () => {
      // pruneExcept's id-format filter is path-traversal defense — it must
      // skip anything in the dir that couldn't possibly be one of our files
      // (names with `.`, `/`, etc.). Bare alnum names that happen to match
      // the id format are still candidates for deletion; that's accepted
      // behavior since we own the directory.
      writeFileSync(join(dataDir, "scrollback", ".gitkeep"), "");
      writeFileSync(join(dataDir, "scrollback", "with.dots"), "x");

      store.pruneExcept([]);

      assert.ok(existsSync(join(dataDir, "scrollback", ".gitkeep")));
      assert.ok(existsSync(join(dataDir, "scrollback", "with.dots")));
    });

    it("handles a missing scrollback dir without throwing", () => {
      rmSync(join(dataDir, "scrollback"), { recursive: true, force: true });
      // Should not throw.
      store.pruneExcept(["anything"]);
    });
  });

  describe("no-op store (no dataDir)", () => {
    it("returns a store that silently swallows all operations", () => {
      const noop = createScrollbackStore({ dataDir: null });

      noop.save("id", "data", 4);  // no throw
      assert.strictEqual(noop.load("id"), null);
      noop.remove("id");           // no throw
      noop.pruneExcept(["a"]);     // no throw
    });
  });

  describe("session-restart simulation", () => {
    it("a saved buffer can be loaded after the original store object is gone", () => {
      // Save with one store instance; load with a fresh one. This is what
      // happens across a real katulong restart.
      store.save("restart_id", "scrollback contents", 1000);

      const reborn = createScrollbackStore({ dataDir });
      const loaded = reborn.load("restart_id");

      assert.deepStrictEqual(loaded, { data: "scrollback contents", cursor: 1000 });
    });

    it("loading a file from disk that was hand-written matches the format spec", () => {
      // This guards the file format itself: anyone debugging by writing
      // a scrollback file by hand should be able to follow the documented
      // shape. If someone changes the format without updating docs/tests,
      // this fails first.
      const filePath = join(dataDir, "scrollback", "manual_id");
      writeFileSync(filePath, "42\nhello there");

      const loaded = store.load("manual_id");
      assert.deepStrictEqual(loaded, { data: "hello there", cursor: 42 });

      // And the on-disk content can be inspected with cat or grep.
      const raw = readFileSync(filePath, "utf-8");
      assert.strictEqual(raw, "42\nhello there");
    });
  });
});
