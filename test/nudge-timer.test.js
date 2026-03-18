import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createNudgeTimer } from "../public/lib/nudge-timer.js";

describe("createNudgeTimer", () => {
  let sent, timer, mockWs;

  beforeEach(() => {
    sent = [];
    mockWs = {
      readyState: 1,
      send(data) { sent.push(JSON.parse(data)); },
    };
    timer = createNudgeTimer({ getWS: () => mockWs });
  });

  afterEach(() => {
    timer.stop();
  });

  it("sends seq-query after start", async () => {
    timer.start();
    // Wait for first tick (2s + margin)
    await new Promise(r => setTimeout(r, 2200));
    assert.ok(sent.length >= 1);
    assert.deepEqual(sent[0], { type: "seq-query" });
  });

  it("doubles interval on each tick (backoff)", async () => {
    timer.start();
    // First tick at 2s
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(sent.length, 1);

    // Second tick at 4s (total ~6.2s from start)
    await new Promise(r => setTimeout(r, 4200));
    assert.equal(sent.length, 2);
  });

  it("reset restores interval to 2s", async () => {
    timer.start();
    // Let two ticks fire (2s + 4s)
    await new Promise(r => setTimeout(r, 6500));
    const countBefore = sent.length;

    // Reset
    timer.reset();

    // Next tick should be at 2s again
    await new Promise(r => setTimeout(r, 2200));
    assert.ok(sent.length > countBefore);
  });

  it("stop prevents further ticks", async () => {
    timer.start();
    await new Promise(r => setTimeout(r, 2200));
    const count = sent.length;
    timer.stop();
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(sent.length, count);
  });

  it("does not send when ws is not open", async () => {
    mockWs.readyState = 3; // CLOSED
    timer.start();
    await new Promise(r => setTimeout(r, 2200));
    assert.equal(sent.length, 0);
  });

  it("start is idempotent", () => {
    timer.start();
    timer.start();
    timer.start();
    // Just shouldn't throw or create multiple timers
    timer.stop();
  });
});
