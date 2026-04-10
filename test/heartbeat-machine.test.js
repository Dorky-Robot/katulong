import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  create,
  reset,
  sendPing,
  receivePong,
  tick,
  INTERVAL_MS,
  TIMEOUT_MS,
} from "../public/lib/heartbeat-machine.js";

describe("heartbeat-machine", () => {
  // ── create() ────────────────────────────────────────────────────────
  describe("create()", () => {
    it("returns correct initial state (idle, sentAt 0, epoch 0)", () => {
      const state = create();
      assert.deepStrictEqual(state, { status: "idle", sentAt: 0, epoch: 0 });
    });
  });

  // ── reset() ─────────────────────────────────────────────────────────
  describe("reset()", () => {
    it("resets to idle with new epoch", () => {
      const initial = create();
      const { state, effects } = reset(initial, 5);
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.equal(state.epoch, 5);
      assert.deepStrictEqual(effects, []);
    });

    it("clears sentAt when resetting from waiting state", () => {
      const waiting = { status: "waiting", sentAt: 12345, epoch: 1 };
      const { state } = reset(waiting, 2);
      assert.equal(state.sentAt, 0);
      assert.equal(state.status, "idle");
      assert.equal(state.epoch, 2);
    });

    it("preserves no state from previous — always returns idle/0/newEpoch", () => {
      const prev = { status: "waiting", sentAt: 99999, epoch: 42 };
      const { state } = reset(prev, 7);
      assert.deepStrictEqual(state, { status: "idle", sentAt: 0, epoch: 7 });
    });
  });

  // ── sendPing() ──────────────────────────────────────────────────────
  describe("sendPing()", () => {
    it("from idle: transitions to waiting, sets sentAt, returns sendPing effect", () => {
      const idle = { status: "idle", sentAt: 0, epoch: 1 };
      const now = 1000;
      const { state, effects } = sendPing(idle, now);
      assert.equal(state.status, "waiting");
      assert.equal(state.sentAt, now);
      assert.equal(state.epoch, 1);
      assert.deepStrictEqual(effects, [{ type: "sendPing" }]);
    });

    it("from waiting: no-op (idempotent), returns empty effects", () => {
      const waiting = { status: "waiting", sentAt: 500, epoch: 1 };
      const { state, effects } = sendPing(waiting, 2000);
      assert.equal(state.status, "waiting");
      assert.equal(state.sentAt, 500); // unchanged — still the original sentAt
      assert.deepStrictEqual(effects, []);
    });

    it("does not modify epoch", () => {
      const idle = { status: "idle", sentAt: 0, epoch: 3 };
      const { state } = sendPing(idle, 1000);
      assert.equal(state.epoch, 3);
    });
  });

  // ── receivePong() ───────────────────────────────────────────────────
  describe("receivePong()", () => {
    it("matching epoch + waiting: transitions to idle, clears sentAt, empty effects", () => {
      const waiting = { status: "waiting", sentAt: 1000, epoch: 2 };
      const { state, effects } = receivePong(waiting, 2);
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.equal(state.epoch, 2);
      assert.deepStrictEqual(effects, []);
    });

    it("stale epoch: no-op regardless of status (returns state unchanged)", () => {
      const waiting = { status: "waiting", sentAt: 1000, epoch: 5 };
      const { state, effects } = receivePong(waiting, 4); // old epoch
      assert.equal(state.status, "waiting");
      assert.equal(state.sentAt, 1000);
      assert.deepStrictEqual(effects, []);
    });

    it("not waiting (idle): no-op even with matching epoch", () => {
      const idle = { status: "idle", sentAt: 0, epoch: 3 };
      const { state, effects } = receivePong(idle, 3);
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.deepStrictEqual(effects, []);
    });

    it("does not modify epoch", () => {
      const waiting = { status: "waiting", sentAt: 1000, epoch: 8 };
      const { state } = receivePong(waiting, 8);
      assert.equal(state.epoch, 8);
    });
  });

  // ── tick() ──────────────────────────────────────────────────────────
  describe("tick()", () => {
    it("not waiting: no-op (returns state unchanged, empty effects)", () => {
      const idle = { status: "idle", sentAt: 0, epoch: 1 };
      const { state, effects } = tick(idle, 99999);
      assert.equal(state.status, "idle");
      assert.deepStrictEqual(effects, []);
    });

    it("waiting but not timed out (now - sentAt < TIMEOUT_MS): no-op", () => {
      const sentAt = 1000;
      const waiting = { status: "waiting", sentAt, epoch: 1 };
      const now = sentAt + TIMEOUT_MS - 100; // well within timeout
      const { state, effects } = tick(waiting, now);
      assert.equal(state.status, "waiting");
      assert.equal(state.sentAt, sentAt);
      assert.deepStrictEqual(effects, []);
    });

    it("waiting and timed out (now - sentAt >= TIMEOUT_MS): transitions to idle, returns timeout effect", () => {
      const sentAt = 1000;
      const waiting = { status: "waiting", sentAt, epoch: 1 };
      const now = sentAt + TIMEOUT_MS + 500; // well past timeout
      const { state, effects } = tick(waiting, now);
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.deepStrictEqual(effects, [{ type: "timeout" }]);
    });

    it("exactly at timeout boundary (now - sentAt === TIMEOUT_MS): triggers timeout", () => {
      const sentAt = 2000;
      const waiting = { status: "waiting", sentAt, epoch: 1 };
      const now = sentAt + TIMEOUT_MS; // exactly at boundary
      const { state, effects } = tick(waiting, now);
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.deepStrictEqual(effects, [{ type: "timeout" }]);
    });

    it("just before timeout (now - sentAt === TIMEOUT_MS - 1): no-op", () => {
      const sentAt = 2000;
      const waiting = { status: "waiting", sentAt, epoch: 1 };
      const now = sentAt + TIMEOUT_MS - 1; // 1ms before timeout
      const { state, effects } = tick(waiting, now);
      assert.equal(state.status, "waiting");
      assert.equal(state.sentAt, sentAt);
      assert.deepStrictEqual(effects, []);
    });
  });

  // ── Integration sequence tests ──────────────────────────────────────
  describe("integration sequences", () => {
    it("full ping-pong cycle: create -> sendPing -> receivePong -> back to idle", () => {
      let state = create();
      assert.equal(state.status, "idle");

      // Send ping
      const r1 = sendPing(state, 1000);
      state = r1.state;
      assert.equal(state.status, "waiting");
      assert.deepStrictEqual(r1.effects, [{ type: "sendPing" }]);

      // Receive pong
      const r2 = receivePong(state, state.epoch);
      state = r2.state;
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.deepStrictEqual(r2.effects, []);
    });

    it("ping timeout cycle: create -> sendPing -> tick (before) -> tick (after) -> idle with timeout", () => {
      let state = create();
      const now = 5000;

      // Send ping
      const r1 = sendPing(state, now);
      state = r1.state;
      assert.equal(state.status, "waiting");

      // Tick before timeout — no-op
      const r2 = tick(state, now + TIMEOUT_MS - 1);
      state = r2.state;
      assert.equal(state.status, "waiting");
      assert.deepStrictEqual(r2.effects, []);

      // Tick after timeout — triggers timeout
      const r3 = tick(state, now + TIMEOUT_MS);
      state = r3.state;
      assert.equal(state.status, "idle");
      assert.equal(state.sentAt, 0);
      assert.deepStrictEqual(r3.effects, [{ type: "timeout" }]);
    });

    it("epoch guard across reconnect: sendPing -> reset(newEpoch) -> receivePong(oldEpoch) -> ignored", () => {
      let state = create();
      const oldEpoch = state.epoch; // 0

      // Send ping on old connection
      const r1 = sendPing(state, 1000);
      state = r1.state;
      assert.equal(state.status, "waiting");

      // Reconnect with new epoch
      const newEpoch = 1;
      const r2 = reset(state, newEpoch);
      state = r2.state;
      assert.equal(state.status, "idle");
      assert.equal(state.epoch, newEpoch);

      // Stale pong from old connection arrives — should be ignored
      const r3 = receivePong(state, oldEpoch);
      state = r3.state;
      assert.equal(state.status, "idle");
      assert.equal(state.epoch, newEpoch); // unchanged
      assert.deepStrictEqual(r3.effects, []);
    });
  });

  // ── Config constants ────────────────────────────────────────────────
  describe("config constants", () => {
    it("INTERVAL_MS is 10000", () => {
      assert.equal(INTERVAL_MS, 10000);
    });

    it("TIMEOUT_MS is 8000", () => {
      assert.equal(TIMEOUT_MS, 8000);
    });
  });
});
