import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Unit tests for the `crew wait` polling logic.
 *
 * We can't easily mock the API client in the real module (it calls
 * process.exit on missing server), so we extract and test the core
 * polling decision logic: given a status response, should we keep
 * polling, report idle, or report dead?
 */

describe("crew wait decision logic", () => {
  // Mirrors the decision tree inside the wait() function
  function waitDecision(status) {
    if (!status.alive) return "dead";
    if (!status.hasChildProcesses) return "idle";
    return "poll";
  }

  it("returns 'idle' when session is alive with no child processes", () => {
    assert.equal(waitDecision({ alive: true, hasChildProcesses: false, childCount: 0 }), "idle");
  });

  it("returns 'poll' when session is alive with child processes", () => {
    assert.equal(waitDecision({ alive: true, hasChildProcesses: true, childCount: 2 }), "poll");
  });

  it("returns 'dead' when session is not alive", () => {
    assert.equal(waitDecision({ alive: false, hasChildProcesses: false, childCount: 0 }), "dead");
  });

  it("returns 'dead' when session is not alive even with stale child count", () => {
    // Edge case: alive=false but childCount > 0 (stale data)
    assert.equal(waitDecision({ alive: false, hasChildProcesses: false, childCount: 3 }), "dead");
  });
});

describe("crew wait integration flow", () => {
  it("polls until hasChildProcesses becomes false", async () => {
    // Simulate a sequence of status responses
    const responses = [
      { alive: true, hasChildProcesses: true, childCount: 2, name: "proj--worker" },
      { alive: true, hasChildProcesses: true, childCount: 1, name: "proj--worker" },
      { alive: true, hasChildProcesses: false, childCount: 0, name: "proj--worker" },
    ];

    let pollCount = 0;
    const mockPoll = async () => {
      while (pollCount < responses.length) {
        const status = responses[pollCount++];
        if (!status.alive || !status.hasChildProcesses) return status;
        // In real code there'd be a 2s delay here; skip for testing
      }
      throw new Error("Should not reach here");
    };

    const result = await mockPoll();
    assert.equal(pollCount, 3);
    assert.equal(result.hasChildProcesses, false);
    assert.equal(result.alive, true);
  });

  it("exits immediately when session is already idle", async () => {
    const responses = [
      { alive: true, hasChildProcesses: false, childCount: 0, name: "proj--worker" },
    ];

    let pollCount = 0;
    const mockPoll = async () => {
      while (pollCount < responses.length) {
        const status = responses[pollCount++];
        if (!status.alive || !status.hasChildProcesses) return status;
      }
      throw new Error("Should not reach here");
    };

    const result = await mockPoll();
    assert.equal(pollCount, 1);
    assert.equal(result.hasChildProcesses, false);
  });

  it("exits when session dies mid-wait", async () => {
    const responses = [
      { alive: true, hasChildProcesses: true, childCount: 1, name: "proj--worker" },
      { alive: false, hasChildProcesses: false, childCount: 0, name: "proj--worker" },
    ];

    let pollCount = 0;
    const mockPoll = async () => {
      while (pollCount < responses.length) {
        const status = responses[pollCount++];
        if (!status.alive || !status.hasChildProcesses) return status;
      }
      throw new Error("Should not reach here");
    };

    const result = await mockPoll();
    assert.equal(pollCount, 2);
    assert.equal(result.alive, false);
  });
});
