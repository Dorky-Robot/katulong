import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSeqBuffer } from "../public/lib/seq-buffer.js";

describe("createSeqBuffer", () => {
  let flushed, gapTimeouts, seqBuffer;

  beforeEach(() => {
    flushed = [];
    gapTimeouts = [];
    seqBuffer = createSeqBuffer({
      onFlush: (data) => flushed.push(data),
      onGapTimeout: (expectedSeq) => gapTimeouts.push(expectedSeq),
    });
  });

  describe("init", () => {
    it("sets expectedSeq and marks as initialized", () => {
      seqBuffer.init(100);
      assert.equal(seqBuffer.getExpectedSeq(), 100);
      assert.equal(seqBuffer.isInitialized(), true);
    });

    it("clears pending buffer on re-init", () => {
      seqBuffer.init(0);
      // Create a gap
      seqBuffer.push(10, "future");
      assert.equal(flushed.length, 0);

      // Re-init clears the pending gap
      seqBuffer.init(100);
      assert.equal(seqBuffer.getExpectedSeq(), 100);
    });
  });

  describe("in-order flush", () => {
    it("flushes immediately when seq matches expected", () => {
      seqBuffer.init(0);
      seqBuffer.push(0, "hello");
      assert.deepEqual(flushed, ["hello"]);
      assert.equal(seqBuffer.getExpectedSeq(), 5);
    });

    it("flushes consecutive chunks", () => {
      seqBuffer.init(0);
      seqBuffer.push(0, "abc");
      seqBuffer.push(3, "def");
      seqBuffer.push(6, "ghi");
      assert.deepEqual(flushed, ["abc", "def", "ghi"]);
      assert.equal(seqBuffer.getExpectedSeq(), 9);
    });
  });

  describe("out-of-order buffering", () => {
    it("buffers future chunks and drains when gap is filled", () => {
      seqBuffer.init(0);
      // Arrives out of order: chunk at offset 5 before chunk at offset 0
      seqBuffer.push(5, "world");
      assert.equal(flushed.length, 0);

      // Fill the gap
      seqBuffer.push(0, "hello");
      assert.deepEqual(flushed, ["hello", "world"]);
      assert.equal(seqBuffer.getExpectedSeq(), 10);
    });

    it("buffers multiple out-of-order chunks", () => {
      seqBuffer.init(0);
      seqBuffer.push(6, "ghi");
      seqBuffer.push(3, "def");
      assert.equal(flushed.length, 0);

      seqBuffer.push(0, "abc");
      assert.deepEqual(flushed, ["abc", "def", "ghi"]);
    });
  });

  describe("duplicates", () => {
    it("discards fully duplicate chunks", () => {
      seqBuffer.init(0);
      seqBuffer.push(0, "hello");
      seqBuffer.push(0, "hello"); // duplicate
      assert.deepEqual(flushed, ["hello"]);
      assert.equal(seqBuffer.getExpectedSeq(), 5);
    });

    it("trims overlapping chunks", () => {
      seqBuffer.init(0);
      seqBuffer.push(0, "hello");
      // Overlapping: starts at 3, but we've already consumed up to 5
      seqBuffer.push(3, "lo world");
      assert.deepEqual(flushed, ["hello", " world"]);
      assert.equal(seqBuffer.getExpectedSeq(), 11);
    });
  });

  describe("gap timeout", () => {
    it("triggers onGapTimeout after 2s gap", async () => {
      seqBuffer.init(0);
      seqBuffer.push(10, "future"); // gap: expected 0, got 10

      // Wait for gap timer (2s + margin)
      await new Promise(r => setTimeout(r, 2200));
      assert.equal(gapTimeouts.length, 1);
      assert.equal(gapTimeouts[0], 0);
    });

    it("clears gap timer when gap is filled", async () => {
      seqBuffer.init(0);
      seqBuffer.push(5, "world");

      // Fill the gap before timeout fires
      seqBuffer.push(0, "hello");

      await new Promise(r => setTimeout(r, 2200));
      assert.equal(gapTimeouts.length, 0); // no timeout fired
    });
  });

  describe("window overflow", () => {
    it("triggers catchup when pending exceeds 32 entries", () => {
      seqBuffer.init(0);
      // Push 33 out-of-order chunks
      for (let i = 1; i <= 33; i++) {
        seqBuffer.push(i * 100, `chunk${i}`);
      }
      assert.equal(gapTimeouts.length, 1);
      assert.equal(gapTimeouts[0], 0);
    });
  });

  describe("clear", () => {
    it("resets state", () => {
      seqBuffer.init(50);
      seqBuffer.push(60, "buffered");
      seqBuffer.clear();
      assert.equal(seqBuffer.isInitialized(), false);
      assert.equal(seqBuffer.getExpectedSeq(), 0);
    });
  });

  describe("uninitialized", () => {
    it("returns false when pushing before init", () => {
      const result = seqBuffer.push(0, "data");
      assert.equal(result, false);
      assert.equal(flushed.length, 0);
    });
  });
});
