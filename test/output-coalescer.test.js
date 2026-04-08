/**
 * Tests for lib/output-coalescer.js.
 *
 * The coalescer is a pure scheduler — it has no dependency on sessions,
 * bridges, or terminal semantics. These tests exercise the timing contract
 * in isolation so regressions don't require a full session-manager
 * integration test to diagnose.
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
      onFlush: (key, fromSeq) => {
        flushes.push({ key, fromSeq });
      },
      idleMs: 30,
      capMs: 200,
    });
  });

  afterEach(() => {
    coalescer.shutdown();
  });

  describe("notify", () => {
    it("fires onFlush once after the idle window elapses", async () => {
      coalescer.notify("alpha", 10);
      assert.equal(flushes.length, 0, "should not flush immediately");
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.deepEqual(flushes[0], { key: "alpha", fromSeq: 10 });
    });

    it("captures fromSeq on the first notify and holds it until flush", async () => {
      coalescer.notify("alpha", 100);
      coalescer.notify("alpha", 200);  // should be ignored for fromSeq
      coalescer.notify("alpha", 300);
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.equal(flushes[0].fromSeq, 100, "fromSeq should be first notify, not latest");
    });

    it("resets the idle timer on each notify", async () => {
      // Manual flush is deterministic; sleep + assert would be racy under load.
      coalescer.notify("alpha", 10);
      // Keep resetting the idle timer by re-notifying every 10ms (well under
      // idleMs=30) for 100ms. If idle did NOT reset, the batch would flush
      // after the first 30ms window.
      for (let i = 0; i < 10; i++) {
        await sleep(10);
        coalescer.notify("alpha", 20 + i);
      }
      assert.equal(flushes.length, 0, "idle timer should keep resetting as long as notifies arrive");
      // Now stop notifying and wait for idle to fire.
      await sleep(80);
      assert.equal(flushes.length, 1);
      assert.equal(flushes[0].fromSeq, 10, "fromSeq should remain the first notify");
    });

    it("enforces the hard cap against continuous notify floods", async () => {
      // Use wider windows so this test is robust under full-suite load
      // where the event loop can be backed up by other tests.
      const localFlushes = [];
      const longRunner = createOutputCoalescer({
        onFlush: (key, fromSeq) => localFlushes.push({ key, fromSeq }),
        idleMs: 10,   // idle would never fire under the 3ms interval below
        capMs: 50,
      });
      try {
        // Keep notifying — idle timer should always get reset, so only cap can flush.
        const interval = setInterval(() => longRunner.notify("alpha", 0), 3);
        try {
          await sleep(150);  // 3x capMs — generous slack for slow test runs
          assert.ok(localFlushes.length >= 1, "cap timer should fire under continuous load");
        } finally {
          clearInterval(interval);
        }
      } finally {
        longRunner.shutdown();
      }
    });

    it("coalesces notifies per-key independently", async () => {
      coalescer.notify("alpha", 10);
      coalescer.notify("beta", 99);
      await sleep(80);
      assert.equal(flushes.length, 2);
      const byKey = Object.fromEntries(flushes.map(f => [f.key, f.fromSeq]));
      assert.equal(byKey.alpha, 10);
      assert.equal(byKey.beta, 99);
    });
  });

  describe("flush", () => {
    it("flushes immediately and cancels the pending timers", async () => {
      coalescer.notify("alpha", 42);
      coalescer.flush("alpha");
      assert.equal(flushes.length, 1);
      assert.deepEqual(flushes[0], { key: "alpha", fromSeq: 42 });
      // Wait longer than idle/cap to ensure no second flush fires.
      await sleep(250);
      assert.equal(flushes.length, 1, "timers should have been cleared on manual flush");
    });

    it("is a no-op when no batch is pending", () => {
      coalescer.flush("nothing-here");
      assert.equal(flushes.length, 0);
    });
  });

  describe("cancel", () => {
    it("drops the pending batch without calling onFlush", async () => {
      coalescer.notify("alpha", 7);
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
      coalescer.notify("alpha", 1);
      coalescer.notify("beta", 2);
      coalescer.notify("gamma", 3);
      coalescer.shutdown();
      await sleep(250);
      assert.equal(flushes.length, 0, "shutdown must not drain pending batches");
    });

    it("is safe to call multiple times", () => {
      coalescer.notify("alpha", 1);
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
