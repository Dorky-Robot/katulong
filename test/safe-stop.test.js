/**
 * Tests for `safeStopServer` in `lib/cli/safe-stop.js`.
 *
 * Regression coverage for the launchd KeepAlive race in `stop.js` / `restart.js`:
 *
 *   1. Send SIGTERM to a LaunchAgent-managed PID
 *   2. Process exits
 *   3. launchd sees SuccessfulExit=false and IMMEDIATELY respawns the server
 *   4. `isServerRunning()` falls back to its port probe and returns running=true
 *      (the respawn is now on the port)
 *   5. stop.js calls SIGKILL against the ORIGINAL PID → ESRCH, because the
 *      original process is dead (launchd killed it and spawned a new one)
 *   6. User sees "kill ESRCH" and "Server may still be running"
 *
 * The fix, learned in `_finish-upgrade.js` (commit 50773fc) but never
 * backported to stop/restart, is: when a LaunchAgent plist exists, call
 * `launchctl unload/bootout` BEFORE any signals. This tells launchd to
 * stop managing AND stop the process without triggering respawn. Direct
 * signals bypass launchd's lifecycle management and always lose the race.
 *
 * The other half of the bug is that stop.js polls `isServerRunning()` in
 * its wait loop. `isServerRunning()`'s third fallback is a TCP port probe,
 * which cannot distinguish "the process we asked to die is still listening"
 * from "a new process is now listening on the same port." The helper must
 * poll the SPECIFIC old PID via `isProcessRunning(pid)`, not ask "is anything
 * on the port?"
 *
 * Related lessons encoded in the tests:
 *   - `e78a593`: `child.killed` is unreliable; use exitCode === null.
 *     Here we use `isAlive(pid)` which wraps `process.kill(pid, 0)`.
 *   - `a2aa1b5`: EPERM from process.kill(pid, 0) means alive-but-foreign.
 *     We rely on `isProcessRunning` already handling this correctly.
 *   - `e443ec7`: tests that touch KATULONG_DATA_DIR must use mkdtempSync
 *     and override the env var BEFORE dynamic import. Even though this
 *     test doesn't touch disk state directly, `safe-stop.js` transitively
 *     imports process-manager.js which captures data dir at load time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force KATULONG_DATA_DIR to a private tmpdir before the module under test
// loads — the same pattern used by process-manager-server-detection.test.js.
// Without this, a developer running tests from inside a katulong tmux pane
// would see state-dir paths bleed into whatever safe-stop.js transitively
// loads via process-manager.js.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "katulong-safestop-test-"));
process.env.KATULONG_DATA_DIR = TEST_DATA_DIR;
process.on("exit", () => {
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const { safeStopServer } = await import("../lib/cli/safe-stop.js");

/**
 * State-based mock harness for safeStopServer.
 *
 * Rather than pre-listing what `isAlive` should return on each poll (brittle
 * against loop timing), we model the process as a state machine with two
 * transitions: "this signal kills it" and "unload kills it". Tests describe
 * the scenario by setting `stopOnSignal`, `unloadKills`, and optionally a
 * `killThrows` behavior. The mock mirrors how a real kernel + launchd
 * actually interact: a kill succeeds → the process dies → isAlive returns
 * false thereafter. No counting, no order-of-poll guessing.
 */
function makeMocks({
  plistExists = false,
  stopOnSignal = ["SIGTERM", "SIGKILL"], // which signals kill the mock process
  unloadKills = true,                    // does launchctl unload stop it
  initiallyAlive = true,
  killThrows,                            // (signal) => Error | null — override per-signal
} = {}) {
  const state = { alive: initiallyAlive };
  const order = [];
  const calls = {
    plistExists: 0,
    unload: 0,
    isAlive: 0,
    kill: [],
    sleep: 0,
  };

  return {
    state,
    calls,
    order,
    mocks: {
      plistExists: () => {
        calls.plistExists++;
        order.push("plistExists");
        return plistExists;
      },
      unload: () => {
        calls.unload++;
        order.push("unload");
        if (unloadKills) state.alive = false;
      },
      isAlive: (_pid) => {
        calls.isAlive++;
        return state.alive;
      },
      kill: (pid, signal) => {
        calls.kill.push({ pid, signal });
        order.push(`kill:${signal}`);
        if (killThrows) {
          const err = killThrows(signal);
          if (err) throw err;
        }
        if (stopOnSignal.includes(signal)) {
          state.alive = false;
        }
      },
      sleep: async (_ms) => {
        calls.sleep++;
      },
    },
  };
}

const OLD_PID = 12345;

function esrch() {
  const err = new Error("kill ESRCH");
  err.code = "ESRCH";
  return err;
}

describe("safeStopServer — no LaunchAgent", () => {
  it("SIGTERM succeeds cleanly when process exits before timeout", async () => {
    const { mocks, calls } = makeMocks({
      plistExists: false,
      stopOnSignal: ["SIGTERM"],
    });

    const result = await safeStopServer({ pid: OLD_PID, ...mocks });

    assert.equal(result.stopped, true);
    assert.equal(result.usedLaunchctl, false);
    assert.equal(result.escalated, false);
    assert.equal(result.error, null);

    // One SIGTERM to the old PID, no SIGKILL.
    assert.equal(calls.kill.length, 1);
    assert.deepEqual(calls.kill[0], { pid: OLD_PID, signal: "SIGTERM" });
    assert.equal(calls.unload, 0);
  });

  it("escalates to SIGKILL against the OLD pid when SIGTERM is ignored", async () => {
    // Only SIGKILL kills the mock process — SIGTERM is a no-op.
    const { mocks, calls } = makeMocks({
      plistExists: false,
      stopOnSignal: ["SIGKILL"],
    });

    const result = await safeStopServer({
      pid: OLD_PID,
      timeoutMs: 5,
      pollIntervalMs: 1,
      ...mocks,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.escalated, true);

    // Exactly: SIGTERM, then SIGKILL — both against the old PID.
    assert.equal(calls.kill.length, 2);
    assert.deepEqual(calls.kill[0], { pid: OLD_PID, signal: "SIGTERM" });
    assert.deepEqual(calls.kill[1], { pid: OLD_PID, signal: "SIGKILL" });
  });

  it("treats ESRCH on SIGTERM as success (process already gone)", async () => {
    // The process is already dead before we even tried — kill throws ESRCH.
    const { mocks, calls } = makeMocks({
      plistExists: false,
      initiallyAlive: false,
      killThrows: () => esrch(),
    });

    const result = await safeStopServer({ pid: OLD_PID, ...mocks });

    assert.equal(result.stopped, true);
    assert.equal(result.escalated, false);
    assert.equal(result.error, null);

    // SIGTERM was attempted, ESRCH was caught, no SIGKILL retry.
    assert.equal(calls.kill.length, 1);
    assert.deepEqual(calls.kill[0], { pid: OLD_PID, signal: "SIGTERM" });
  });

  it("treats ESRCH on SIGKILL as success (process died between checks)", async () => {
    // SIGTERM doesn't kill it (so we escalate), but by the time SIGKILL
    // runs the process is gone — kernel returns ESRCH. That's still success:
    // the whole point was to kill it, and it's dead.
    const { mocks, calls } = makeMocks({
      plistExists: false,
      stopOnSignal: [], // nothing kills the mock via its own state transitions
      killThrows: (signal) => (signal === "SIGKILL" ? esrch() : null),
    });

    const result = await safeStopServer({
      pid: OLD_PID,
      timeoutMs: 5,
      pollIntervalMs: 1,
      ...mocks,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.escalated, true);
    assert.equal(result.error, null);
    assert.equal(calls.kill.length, 2);
  });
});

describe("safeStopServer — LaunchAgent present", () => {
  it("calls launchctl unload BEFORE any signals (the core bug fix)", async () => {
    // launchctl unload is the correct way to stop a KeepAlive process —
    // direct SIGTERM causes launchd to immediately respawn it.
    const { mocks, calls, order } = makeMocks({
      plistExists: true,
      unloadKills: true,
    });

    const result = await safeStopServer({ pid: OLD_PID, ...mocks });

    assert.equal(result.stopped, true);
    assert.equal(result.usedLaunchctl, true);
    assert.equal(result.escalated, false);

    // Unload was called. No SIGTERM at all — that's the whole point.
    assert.equal(calls.unload, 1);
    assert.equal(calls.kill.length, 0);

    // Unload must happen BEFORE anything else that could signal.
    const unloadIdx = order.indexOf("unload");
    const firstKillIdx = order.findIndex((s) => s.startsWith("kill:"));
    assert.ok(unloadIdx >= 0, "unload must be called");
    assert.ok(
      firstKillIdx === -1 || unloadIdx < firstKillIdx,
      "unload must come before any kill",
    );
  });

  it("escalates to SIGKILL only if unload fails to stop the process", async () => {
    // Unload returned but didn't kill the process (unusual but possible:
    // process stuck in an uninterruptible syscall, or unload failed silently).
    // Fall back to SIGKILL against the specific old PID — NEVER SIGTERM,
    // because that would trigger KeepAlive respawn.
    const { mocks, calls, order } = makeMocks({
      plistExists: true,
      unloadKills: false,       // unload doesn't kill the mock
      stopOnSignal: ["SIGKILL"], // only SIGKILL kills it
    });

    const result = await safeStopServer({
      pid: OLD_PID,
      timeoutMs: 5,
      pollIntervalMs: 1,
      ...mocks,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.usedLaunchctl, true);
    assert.equal(result.escalated, true);

    // Exactly one SIGKILL, never SIGTERM.
    assert.equal(calls.kill.length, 1);
    assert.deepEqual(calls.kill[0], { pid: OLD_PID, signal: "SIGKILL" });

    // The signal happens AFTER unload.
    assert.ok(order.indexOf("unload") < order.indexOf("kill:SIGKILL"));
  });

  it("does NOT signal the old PID after launchd respawn (regression)", async () => {
    // This is the exact bug. Sequence:
    //   1. plistExists → true
    //   2. unload → old PID dies (launchd stops managing it)
    //   3. In reality, if launchd were still active it would respawn a NEW
    //      server on the port. The helper must not care: it polls the OLD
    //      PID specifically, not the port.
    //   4. Old PID is dead → success.
    //   5. No SIGKILL against old PID (that would ESRCH).
    //   6. No SIGKILL against "whatever's on the port" (a different PID).
    const { mocks, calls } = makeMocks({
      plistExists: true,
      unloadKills: true,
    });

    const result = await safeStopServer({ pid: OLD_PID, ...mocks });

    assert.equal(result.stopped, true);
    assert.equal(result.escalated, false);
    assert.equal(result.error, null);
    // No signals sent at all — launchctl did all the work.
    assert.equal(calls.kill.length, 0);
  });

  it("treats ESRCH on the escalation SIGKILL as success", async () => {
    // Escalation path: unload didn't stop process, SIGKILL is attempted,
    // but process died between unload and SIGKILL (common if unload's
    // shutdown took the process out asynchronously). Should be success.
    const { mocks, calls } = makeMocks({
      plistExists: true,
      unloadKills: false,
      stopOnSignal: [],
      killThrows: (signal) => (signal === "SIGKILL" ? esrch() : null),
    });

    const result = await safeStopServer({
      pid: OLD_PID,
      timeoutMs: 5,
      pollIntervalMs: 1,
      ...mocks,
    });

    assert.equal(result.stopped, true);
    assert.equal(result.escalated, true);
    assert.equal(result.error, null);
  });
});

describe("safeStopServer — input validation", () => {
  it("returns stopped=true with no signals when pid is null", async () => {
    // Caller couldn't determine a PID. Nothing to stop.
    const { mocks, calls } = makeMocks({ plistExists: false });

    const result = await safeStopServer({ pid: null, ...mocks });

    assert.equal(result.stopped, true);
    assert.equal(calls.kill.length, 0);
    assert.equal(calls.unload, 0);
  });
});

describe("safeStopServer — default timeout contract", () => {
  it("default budget = drainTimeout + named tail slack", async () => {
    // The bug this guards against: if safeStopServer's caller-side
    // watchdog fires before the server's own drain wait completes,
    // a healthy graceful shutdown gets SIGKILLed mid-flight, skipping
    // sessionManager.shutdown() (which sends in-band detach-client to
    // each tmux control mode child to dodge the 3.6a UAF). The
    // `katulong update` race we hit on mac2019/mac2024 in v0.61.3 was
    // this exact failure mode.
    //
    // Asserting equality with SHUTDOWN_TAIL_SLACK_MS (rather than just
    // shutdownBudget > drainTimeout) catches both regression vectors:
    // someone reverting the derivation, AND someone shrinking the
    // slack to a value too small to cover the synchronous tail
    // (sessionManager.shutdown → shutdownPlugins → cleanupPidFile).
    const { default: envConfig, SHUTDOWN_TAIL_SLACK_MS } = await import(
      "../lib/env-config.js"
    );
    assert.equal(
      envConfig.shutdownBudget - envConfig.drainTimeout,
      SHUTDOWN_TAIL_SLACK_MS,
      `shutdownBudget (${envConfig.shutdownBudget}ms) must equal drainTimeout (${envConfig.drainTimeout}ms) + SHUTDOWN_TAIL_SLACK_MS (${SHUTDOWN_TAIL_SLACK_MS}ms)`,
    );
  });
});
