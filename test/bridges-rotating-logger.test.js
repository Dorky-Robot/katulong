/**
 * Tests for bridges/_lib/rotating-logger.js — per-week JSON-line file
 * rotation. Covers the Sunday math, the file-name handoff at week
 * boundaries, and the never-throw fallback contract.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sundayOfWeekUTC,
  createRotatingLogger,
} from "../bridges/_lib/rotating-logger.js";

// Tiny helper: drain any buffered writes so the file content is visible
// to readFileSync. Node's writeStream.write() is async; ending the stream
// is the simplest deterministic flush.
function readLines(path) {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("sundayOfWeekUTC", () => {
  it("returns the same date for a Sunday", () => {
    // 2026-05-03 is a Sunday in UTC.
    assert.equal(sundayOfWeekUTC(new Date("2026-05-03T00:00:00Z")), "2026-05-03");
    assert.equal(sundayOfWeekUTC(new Date("2026-05-03T23:59:59Z")), "2026-05-03");
  });

  it("walks back to the previous Sunday for a Monday", () => {
    assert.equal(sundayOfWeekUTC(new Date("2026-05-04T12:00:00Z")), "2026-05-03");
  });

  it("walks back to the previous Sunday for a Saturday", () => {
    // 2026-05-02 is a Saturday — Sunday-of-week is Apr 26.
    assert.equal(sundayOfWeekUTC(new Date("2026-05-02T23:59:59Z")), "2026-04-26");
  });

  it("crosses year boundaries correctly", () => {
    // 2027-01-01 is a Friday; the Sunday that begins its week is 2026-12-27.
    assert.equal(sundayOfWeekUTC(new Date("2027-01-01T08:00:00Z")), "2026-12-27");
  });
});

describe("createRotatingLogger", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bridge-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the log directory lazily on first write", () => {
    const logsDir = join(dir, "logs");
    const logger = createRotatingLogger({
      dir: logsDir,
      now: () => new Date("2026-05-01T22:00:00Z"),
    });
    logger({ event: "hello" });
    logger.close();

    const files = readdirSync(logsDir);
    assert.deepEqual(files, ["2026-04-26.log"]);
  });

  it("appends multiple entries within the same week to one file", () => {
    let n = 0;
    // Each call advances time by one second within the same week.
    const logger = createRotatingLogger({
      dir,
      now: () => new Date(Date.UTC(2026, 3, 27, 0, 0, n++)),
    });
    logger({ event: "a" });
    logger({ event: "b" });
    logger({ event: "c" });
    logger.close();

    const files = readdirSync(dir);
    assert.deepEqual(files, ["2026-04-26.log"]);
    const lines = readLines(join(dir, "2026-04-26.log"));
    assert.deepEqual(lines.map((l) => l.event), ["a", "b", "c"]);
    // Timestamps are recorded as UTC ISO strings.
    assert.ok(lines[0].ts.endsWith("Z"));
  });

  it("opens a fresh file when the entry crosses a week boundary", () => {
    const stamps = [
      new Date("2026-05-02T23:59:59Z"), // Saturday — week of Apr 26
      new Date("2026-05-03T00:00:00Z"), // Sunday — new week
      new Date("2026-05-09T22:00:00Z"), // following Saturday — same new week
    ];
    let i = 0;
    const logger = createRotatingLogger({ dir, now: () => stamps[i++] });
    logger({ event: "before" });
    logger({ event: "boundary" });
    logger({ event: "after" });
    logger.close();

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["2026-04-26.log", "2026-05-03.log"]);
    assert.deepEqual(
      readLines(join(dir, "2026-04-26.log")).map((l) => l.event),
      ["before"],
    );
    assert.deepEqual(
      readLines(join(dir, "2026-05-03.log")).map((l) => l.event),
      ["boundary", "after"],
    );
  });

  it("falls back to stderr without throwing when the dir cannot be created", () => {
    // Point the logger at a path that exists as a *file* — mkdir on it
    // throws ENOTDIR. The logger must swallow the error.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const logger = createRotatingLogger({
      dir: join(blocker, "logs"),
      now: () => new Date("2026-05-01T22:00:00Z"),
    });

    const originalWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = (chunk) => {
      captured += chunk;
      return true;
    };
    try {
      assert.doesNotThrow(() => logger({ event: "fallback" }));
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.match(captured, /"event":"fallback"/);
  });
});
