/**
 * Session Summary Store Tests
 *
 * Append-only JSONL persistence for `{ title, summary, at }` records,
 * with bytes-based rotation to a `.jsonl.old` generation. Covers:
 * round-trip, validation, rotation, migration, prune, malformed input.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSummaryStore } from "../lib/session-summary-store.js";

let dataDir;
let store;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kat-summary-"));
  store = createSummaryStore({ dataDir });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const entry = (title, summary, at) => ({ title, summary, at });

describe("session summary store", () => {
  describe("append / read round trip", () => {
    it("appends one record and reads it back", () => {
      store.append("sid_a", entry("Build feature", "Wrote the JSONL store", 100));
      assert.deepStrictEqual(store.read("sid_a"), [
        { title: "Build feature", summary: "Wrote the JSONL store", at: 100 },
      ]);
    });

    it("preserves order across multiple appends", () => {
      store.append("sid_a", entry("first", "1", 100));
      store.append("sid_a", entry("second", "2", 200));
      store.append("sid_a", entry("third", "3", 300));
      const got = store.read("sid_a");
      assert.deepStrictEqual(got.map((e) => e.title), ["first", "second", "third"]);
    });

    it("returns an empty array for a session with no file", () => {
      assert.deepStrictEqual(store.read("never_written"), []);
    });

    it("respects the limit option and returns the most recent N", () => {
      for (let i = 0; i < 50; i++) store.append("sid_a", entry(`t${i}`, `s${i}`, i));
      const got = store.read("sid_a", { limit: 5 });
      assert.deepStrictEqual(got.map((e) => e.title), ["t45", "t46", "t47", "t48", "t49"]);
    });
  });

  describe("entry validation", () => {
    it("ignores entries missing required fields", () => {
      store.append("sid_a", { title: "no summary", at: 1 });
      store.append("sid_a", { summary: "no title", at: 1 });
      store.append("sid_a", { title: "no at", summary: "x" });
      store.append("sid_a", null);
      assert.deepStrictEqual(store.read("sid_a"), []);
    });

    it("ignores entries when fields have wrong types", () => {
      store.append("sid_a", { title: 7, summary: "x", at: 1 });
      store.append("sid_a", { title: "x", summary: 7, at: 1 });
      store.append("sid_a", { title: "x", summary: "y", at: "not a number" });
      assert.deepStrictEqual(store.read("sid_a"), []);
    });
  });

  describe("id validation", () => {
    it("rejects path-traversal attempts in session id", () => {
      store.append("../etc/passwd", entry("title", "sum", 1));
      // Nothing should have been written under the data dir; read returns [].
      assert.deepStrictEqual(store.read("../etc/passwd"), []);
    });

    it("rejects ids with characters outside [A-Za-z0-9_-]", () => {
      store.append("bad id", entry("t", "s", 1));
      store.append("bad/id", entry("t", "s", 1));
      assert.deepStrictEqual(store.read("bad id"), []);
      assert.deepStrictEqual(store.read("bad/id"), []);
    });
  });

  describe("rotation", () => {
    it("rotates the primary file to .jsonl.old once it crosses the byte cap", () => {
      // Each entry is ~250 bytes; 2000 entries comfortably exceeds the
      // 256 KB rotation threshold, forcing at least one rotation.
      const longSummary = "x".repeat(220);
      for (let i = 0; i < 2000; i++) store.append("sid_a", entry(`t${i}`, longSummary, i));

      const primary = join(dataDir, "summaries", "sid_a.jsonl");
      const rotated = join(dataDir, "summaries", "sid_a.jsonl.old");
      assert.ok(existsSync(primary), "primary file should exist after rotation");
      assert.ok(existsSync(rotated), "rotated .old file should exist");

      // Read returns oldest-rotated → newest-primary as a continuous stream.
      const all = store.read("sid_a");
      assert.strictEqual(all.length, 2000);
      assert.strictEqual(all[0].title, "t0");
      assert.strictEqual(all[all.length - 1].title, "t1999");
    });
  });

  describe("migrate", () => {
    it("appends a batch in one write and is a no-op for empty arrays", () => {
      const batch = [entry("a", "1", 1), entry("b", "2", 2), entry("c", "3", 3)];
      store.migrate("sid_a", batch);
      assert.deepStrictEqual(store.read("sid_a").map((e) => e.title), ["a", "b", "c"]);

      store.migrate("sid_a", []);
      store.migrate("sid_b", null);
      assert.deepStrictEqual(store.read("sid_a").length, 3);
      assert.deepStrictEqual(store.read("sid_b"), []);
    });

    it("filters invalid entries out of the batch", () => {
      const batch = [
        entry("ok", "yes", 1),
        { title: "bad", summary: 42, at: 2 },
        entry("ok2", "yes", 3),
      ];
      store.migrate("sid_a", batch);
      assert.deepStrictEqual(store.read("sid_a").map((e) => e.title), ["ok", "ok2"]);
    });

    it("appends migrated entries before any subsequent live appends", () => {
      store.migrate("sid_a", [entry("legacy", "old", 1)]);
      store.append("sid_a", entry("fresh", "new", 2));
      assert.deepStrictEqual(store.read("sid_a").map((e) => e.title), ["legacy", "fresh"]);
    });
  });

  describe("read tolerance", () => {
    it("drops a partial trailing line written by a crashed appender", () => {
      const filePath = join(dataDir, "summaries", "sid_a.jsonl");
      // First a valid record, then a truncated-mid-line second one.
      const valid = JSON.stringify(entry("ok", "complete", 1)) + "\n";
      const partial = "{\"title\":\"truncated\""; // no closing brace, no newline
      writeFileSync(filePath, valid + partial, { mode: 0o600 });

      assert.deepStrictEqual(store.read("sid_a").map((e) => e.title), ["ok"]);
    });
  });

  describe("remove and prune", () => {
    it("removes both primary and rotated files for a session", () => {
      const longSummary = "x".repeat(220);
      for (let i = 0; i < 2000; i++) store.append("sid_a", entry(`t${i}`, longSummary, i));
      const primary = join(dataDir, "summaries", "sid_a.jsonl");
      const rotated = join(dataDir, "summaries", "sid_a.jsonl.old");
      assert.ok(existsSync(primary) && existsSync(rotated));

      store.remove("sid_a");
      assert.ok(!existsSync(primary), "primary should be gone after remove");
      assert.ok(!existsSync(rotated), "rotated should be gone after remove");
    });

    it("pruneExcept deletes files for ids not in the active set", () => {
      store.append("sid_a", entry("a", "1", 1));
      store.append("sid_b", entry("b", "2", 2));
      store.append("sid_c", entry("c", "3", 3));

      store.pruneExcept(["sid_b"]);

      assert.deepStrictEqual(store.read("sid_a"), []);
      assert.deepStrictEqual(store.read("sid_b").map((e) => e.title), ["b"]);
      assert.deepStrictEqual(store.read("sid_c"), []);
    });

    it("pruneExcept ignores files that are not summary files", () => {
      writeFileSync(join(dataDir, "summaries", "README"), "not ours\n", { mode: 0o600 });
      store.append("sid_a", entry("a", "1", 1));
      store.pruneExcept([]); // no active sessions
      assert.ok(existsSync(join(dataDir, "summaries", "README")), "non-summary file should be left alone");
    });
  });

  describe("file permissions", () => {
    it("creates files with mode 0o600 (owner-only)", () => {
      store.append("sid_a", entry("a", "1", 1));
      const mode = statSync(join(dataDir, "summaries", "sid_a.jsonl")).mode & 0o777;
      assert.strictEqual(mode, 0o600);
    });
  });

  describe("no-op store", () => {
    it("returns a working but inert store when dataDir is null", () => {
      const noop = createSummaryStore({ dataDir: null });
      noop.append("sid_a", entry("a", "1", 1));
      assert.deepStrictEqual(noop.read("sid_a"), []);
      noop.migrate("sid_a", [entry("a", "1", 1)]);
      noop.remove("sid_a");
      noop.pruneExcept(["sid_a"]);
    });
  });
});
