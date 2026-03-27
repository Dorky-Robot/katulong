/**
 * Tests for pull-manager.js
 *
 * Pure state machine — no DOM, no xterm, no WebSocket.
 * Tests cover: init, pull, dataAvailable, pullResponse, pullSnapshot,
 * safety timeouts, and multi-session isolation.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createPullManager } from "../public/lib/pull-manager.js";

describe("PullManager", () => {
  let pm, sends, writes, resets;

  beforeEach(() => {
    sends = [];
    writes = [];
    resets = [];
    pm = createPullManager({
      onSendPull: (name, fromSeq) => sends.push({ name, fromSeq }),
      onWrite: (name, data, done) => { writes.push({ name, data, done }); },
      onReset: (name) => resets.push(name),
    });
  });

  describe("init", () => {
    it("creates session state and sends first pull", () => {
      pm.init("a", 100);
      assert.ok(pm.get("a"));
      assert.equal(pm.get("a").cursor, 100);
      assert.equal(sends.length, 1);
      assert.equal(sends[0].fromSeq, 100);
    });

    it("re-init resets state and sends pull", () => {
      pm.init("a", 100);
      pm.get("a").writing = true;
      pm.init("a", 200);
      assert.equal(pm.get("a").cursor, 200);
      assert.equal(pm.get("a").writing, false);
      assert.equal(sends.length, 2);
    });
  });

  describe("clear", () => {
    it("clears specific session", () => {
      pm.init("a", 0);
      pm.init("b", 0);
      pm.clear("a");
      assert.equal(pm.get("a"), undefined);
      assert.ok(pm.get("b"));
    });

    it("clears all sessions", () => {
      pm.init("a", 0);
      pm.init("b", 0);
      pm.clear();
      assert.equal(pm.get("a"), undefined);
      assert.equal(pm.get("b"), undefined);
    });
  });

  describe("dataAvailable", () => {
    it("triggers pull when idle", () => {
      pm.init("a", 0);
      // Simulate pull response to make session idle
      pm.pullResponse("a", "", 0);
      sends.length = 0;
      pm.dataAvailable("a");
      assert.equal(sends.length, 1);
    });

    it("sets pending when pulling", () => {
      pm.init("a", 0); // sends pull, sets pulling=true
      sends.length = 0;
      pm.dataAvailable("a"); // should set pending, not pull
      assert.equal(sends.length, 0);
      assert.equal(pm.get("a").pending, true);
    });

    it("sets pending when writing", () => {
      pm.init("a", 0);
      pm.pullResponse("a", "data", 10); // sets writing=true
      sends.length = 0;
      pm.dataAvailable("a");
      assert.equal(sends.length, 0);
      assert.equal(pm.get("a").pending, true);
    });

    it("no-op for unknown session", () => {
      pm.dataAvailable("ghost"); // should not throw
      assert.equal(sends.length, 0);
    });
  });

  describe("pullResponse", () => {
    it("writes data and advances cursor", () => {
      pm.init("a", 0);
      pm.pullResponse("a", "hello", 5);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].data, "hello");
      assert.equal(pm.get("a").writing, true);

      // Simulate write complete
      writes[0].done();
      assert.equal(pm.get("a").writing, false);
      assert.equal(pm.get("a").cursor, 5);
    });

    it("chains pending pull after write", () => {
      pm.init("a", 0);
      pm.pullResponse("a", "data", 10);
      pm.dataAvailable("a"); // sets pending
      sends.length = 0;

      writes[0].done(); // triggers pending pull
      assert.equal(sends.length, 1);
      assert.equal(sends[0].fromSeq, 10);
    });

    it("handles empty data (caught up)", () => {
      pm.init("a", 100);
      pm.pullResponse("a", "", 100);
      assert.equal(writes.length, 0);
      assert.equal(pm.get("a").cursor, 100);
    });

    it("chains pending pull on empty response", () => {
      pm.init("a", 0);
      pm.get("a").pending = true;
      pm.get("a").pulling = false;
      sends.length = 0;
      pm.pullResponse("a", "", 10);
      assert.equal(sends.length, 1);
    });
  });

  describe("pullSnapshot", () => {
    it("resets terminal before writing", () => {
      pm.init("a", 0);
      pm.pullSnapshot("a", "snapshot", 50);
      assert.equal(resets.length, 1);
      assert.equal(resets[0], "a");
      assert.equal(writes.length, 1);
      assert.equal(writes[0].data, "snapshot");
    });

    it("advances cursor after write complete", () => {
      pm.init("a", 0);
      pm.pullSnapshot("a", "snap", 50);
      writes[0].done();
      assert.equal(pm.get("a").cursor, 50);
    });
  });

  describe("multi-session isolation", () => {
    it("sessions have independent state", () => {
      pm.init("a", 0);
      pm.init("b", 100);

      pm.pullResponse("a", "dataA", 10);
      assert.equal(pm.get("a").writing, true);
      assert.equal(pm.get("b").writing, false);

      // b is still pulling from init, so dataAvailable sets pending
      pm.dataAvailable("b");
      assert.equal(pm.get("b").pending, true);
    });

    it("clearing one session doesn't affect others", () => {
      pm.init("a", 0);
      pm.init("b", 0);
      pm.clear("a");
      pm.dataAvailable("b");
      assert.equal(pm.get("b").pulling, true);
    });
  });

  describe("safety timeouts", () => {
    it("pull timeout retries after PULL_TIMEOUT_MS", async () => {
      pm.init("a", 0);
      assert.equal(sends.length, 1);
      // Wait for safety timeout (5s)
      await new Promise(r => setTimeout(r, 5100));
      assert.ok(sends.length >= 2, "should have retried after timeout");
    });

    it("write timeout unsticks after WRITE_TIMEOUT_MS", async () => {
      pm.init("a", 0);
      pm.pullResponse("a", "data", 10);
      assert.equal(pm.get("a").writing, true);
      // Don't call done() — wait for safety timeout
      await new Promise(r => setTimeout(r, 3100));
      assert.equal(pm.get("a").writing, false);
      assert.equal(pm.get("a").cursor, 10);
    });
  });
});
