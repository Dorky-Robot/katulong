/**
 * Tests for lib/output-coalescer.js.
 *
 * The coalescer is a pure scheduler — it has no dependency on sessions,
 * bridges, or terminal semantics. These tests exercise the timing contract
 * in isolation so regressions don't require a full session-manager
 * integration test to diagnose.
 *
 * Raptor 3: the coalescer used to take a `fromSeq` cursor and expect
 * the caller to re-pull bytes from a RingBuffer on flush. That path
 * existed for client-side replay, which Raptor 3 deletes. The coalescer
 * now holds the concatenated bytes directly and hands them to onFlush.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createOutputCoalescer } from "../lib/output-coalescer.js";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe("OutputCoalescer", () => {
  let flushes;
  let coalescer;

  beforeEach(() => {
    flushes = [];
    // Use generous windows so tests are robust under full-suite load
    // where Node.js setTimeout can slip by tens of milliseconds.
    coalescer = createOutputCoalescer({
      onFlush: (key, data) => {
        flushes.push({ key, data });
      },
      idleMs: 30,
      capMs: 200,
    });
  });

  afterEach(() => {
    coalescer.shutdown();
  });

  describe("push", () => {
    it("fires onFlush once after the idle window elapses", async () => {
      coalescer.push("alpha", "hello");
      assert.equal(flushes.length, 0, "should not flush immediately");
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.deepEqual(flushes[0], { key: "alpha", data: "hello" });
    });

    it("concatenates data chunks across pushes within the same batch", async () => {
      coalescer.push("alpha", "one-");
      coalescer.push("alpha", "two-");
      coalescer.push("alpha", "three");
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.equal(flushes[0].data, "one-two-three", "all chunks should be concatenated in order");
    });

    it("resets the idle timer on each push", async () => {
      // Manual flush is deterministic; sleep + assert would be racy under load.
      coalescer.push("alpha", "a");
      // Keep resetting the idle timer by re-pushing every 10ms (well under
      // idleMs=30) for 100ms. If idle did NOT reset, the batch would flush
      // after the first 30ms window.
      for (let i = 0; i < 10; i++) {
        await sleep(10);
        coalescer.push("alpha", String.fromCharCode(98 + i));
      }
      assert.equal(flushes.length, 0, "idle timer should keep resetting as long as pushes arrive");
      // Now stop pushing and wait for idle to fire.
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.equal(flushes[0].data, "abcdefghijk", "all pushed chunks should be present in order");
    });

    it("enforces the hard cap against continuous push floods", async () => {
      // Use wider windows so this test is robust under full-suite load
      // where the event loop can be backed up by other tests.
      const localFlushes = [];
      const longRunner = createOutputCoalescer({
        onFlush: (key, data) => localFlushes.push({ key, data }),
        idleMs: 10,   // idle would never fire under the 3ms interval below
        capMs: 50,
      });
      try {
        // Keep pushing — idle timer should always get reset, so only cap can flush.
        const interval = setInterval(() => longRunner.push("alpha", "x"), 3);
        try {
          await sleep(150);  // 3x capMs — generous slack for slow test runs
          assert.ok(localFlushes.length >= 1, "cap timer should fire under continuous load");
          // Every flushed batch should contain at least one "x".
          for (const f of localFlushes) {
            assert.ok(f.data.length > 0, "flushed data should not be empty");
          }
        } finally {
          clearInterval(interval);
        }
      } finally {
        longRunner.shutdown();
      }
    });

    it("coalesces pushes per-key independently", async () => {
      coalescer.push("alpha", "A");
      coalescer.push("beta", "B");
      await sleep(80);
      assert.equal(flushes.length, 2);
      const byKey = Object.fromEntries(flushes.map(f => [f.key, f.data]));
      assert.equal(byKey.alpha, "A");
      assert.equal(byKey.beta, "B");
    });
  });

  describe("flush", () => {
    it("flushes immediately and cancels the pending timers", async () => {
      coalescer.push("alpha", "payload");
      coalescer.flush("alpha");
      assert.equal(flushes.length, 1);
      assert.deepEqual(flushes[0], { key: "alpha", data: "payload" });
      // Wait longer than idle/cap to ensure no second flush fires.
      await sleep(250);
      assert.equal(flushes.length, 1, "timers should have been cleared on manual flush");
    });

    it("flushes concatenated data from multiple pushes", () => {
      coalescer.push("alpha", "first-");
      coalescer.push("alpha", "second-");
      coalescer.push("alpha", "third");
      coalescer.flush("alpha");
      assert.equal(flushes.length, 1);
      assert.equal(flushes[0].data, "first-second-third");
    });

    it("is a no-op when no batch is pending", () => {
      coalescer.flush("nothing-here");
      assert.equal(flushes.length, 0);
    });
  });

  describe("cancel", () => {
    it("drops the pending batch without calling onFlush", async () => {
      coalescer.push("alpha", "dropped");
      coalescer.cancel("alpha");
      await sleep(250);
      assert.equal(flushes.length, 0);
    });

    it("is a no-op when no batch is pending", () => {
      coalescer.cancel("ghost");
      assert.equal(flushes.length, 0);
    });
  });

  describe("shutdown", () => {
    it("cancels every pending batch without calling onFlush", async () => {
      coalescer.push("alpha", "1");
      coalescer.push("beta", "2");
      coalescer.push("gamma", "3");
      coalescer.shutdown();
      await sleep(250);
      assert.equal(flushes.length, 0, "shutdown must not drain pending batches");
    });

    it("is safe to call multiple times", () => {
      coalescer.push("alpha", "x");
      coalescer.shutdown();
      coalescer.shutdown();  // idempotent
    });
  });

  describe("constructor validation", () => {
    it("throws when onFlush is not a function", () => {
      assert.throws(
        () => createOutputCoalescer({ onFlush: null }),
        TypeError,
      );
    });
  });
});
