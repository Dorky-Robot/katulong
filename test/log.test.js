import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { log } from "../lib/log.js";

describe("log", () => {
  let stdoutChunks, stderrChunks;
  let origStdout, origStderr;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    origStdout = process.stdout.write;
    origStderr = process.stderr.write;
    process.stdout.write = (chunk) => { stdoutChunks.push(chunk); return true; };
    process.stderr.write = (chunk) => { stderrChunks.push(chunk); return true; };
  });

  afterEach(() => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it("log.info writes JSON to stdout", () => {
    log.info("hello");
    assert.equal(stdoutChunks.length, 1);
    const entry = JSON.parse(stdoutChunks[0]);
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "hello");
    assert.ok(entry.time);
  });

  it("log.warn writes to stderr", () => {
    log.warn("caution");
    assert.equal(stderrChunks.length, 1);
    assert.equal(stdoutChunks.length, 0);
    const entry = JSON.parse(stderrChunks[0]);
    assert.equal(entry.level, "warn");
    assert.equal(entry.msg, "caution");
  });

  it("log.error writes to stderr", () => {
    log.error("bad");
    assert.equal(stderrChunks.length, 1);
    const entry = JSON.parse(stderrChunks[0]);
    assert.equal(entry.level, "error");
    assert.equal(entry.msg, "bad");
  });

  it("includes meta when provided", () => {
    log.info("with-meta", { key: "val" });
    const entry = JSON.parse(stdoutChunks[0]);
    assert.deepEqual(entry.meta, { key: "val" });
  });

  it("omits meta when not provided", () => {
    log.info("no-meta");
    const entry = JSON.parse(stdoutChunks[0]);
    assert.equal(entry.meta, undefined);
  });

  it("time field is valid ISO 8601", () => {
    log.info("time-check");
    const entry = JSON.parse(stdoutChunks[0]);
    const parsed = new Date(entry.time);
    assert.ok(!isNaN(parsed.getTime()));
  });

  it("output ends with newline", () => {
    log.info("newline-check");
    assert.ok(stdoutChunks[0].endsWith("\n"));
  });
});
