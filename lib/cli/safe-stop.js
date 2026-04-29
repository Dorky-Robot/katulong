/**
 * Safely stop a running katulong server, respecting launchd KeepAlive.
 *
 * The bug this helper exists to fix:
 *
 *   `katulong stop` sent SIGTERM directly to the server PID. When a
 *   LaunchAgent is installed, its plist has `KeepAlive.SuccessfulExit=false`,
 *   which tells launchd to treat any death as abnormal and IMMEDIATELY
 *   respawn the process. That respawn raced the stop command's own wait
 *   loop — by the time stop.js polled again, the port was occupied by a
 *   different PID, `isServerRunning()` reported running=true via its port
 *   probe, and stop.js then tried `SIGKILL` against the ORIGINAL (now-dead)
 *   PID, which threw ESRCH. The user saw "kill ESRCH" followed by
 *   "Server may still be running".
 *
 * The lesson was already learned once, in commit 50773fc, and applied to
 * `_finish-upgrade.js`: when a LaunchAgent plist exists, call
 * `launchctl unload/bootout` BEFORE any signals. Unload tells launchd to
 * stop managing AND stop the process without triggering the KeepAlive
 * respawn. Direct signals always lose the race.
 *
 * This file generalizes that fix into a single helper used by `stop.js`,
 * `restart.js` (non-rolling path), and the non-LaunchAgent branch of
 * `_finish-upgrade.js`, so the lesson doesn't have to be re-learned
 * three more times.
 *
 * The other half of the bug: stop.js polled `isServerRunning()` in its
 * wait loop. `isServerRunning()`'s third fallback is a TCP probe on the
 * configured port, which cannot distinguish "the process we asked to die
 * is still listening" from "a NEW process is now listening on the same
 * port" (launchd's respawn, or a resurrected service). The correct thing
 * to poll is the SPECIFIC old PID via `isProcessRunning(pid)` — that's
 * process identity, not port liveness.
 *
 * Related lessons:
 *   - e78a593: `child.killed` is unreliable — it's a "did we send SIGTERM?"
 *     flag, not a "did the child exit?" flag. Always use exitCode === null
 *     (for child_process) or `process.kill(pid, 0)` (for bare PIDs) to
 *     check actual liveness.
 *   - a2aa1b5 / e443ec7: `process.kill(pid, 0)` can throw EPERM for
 *     foreign-user processes — that means "alive but not yours", not "dead".
 *     `isProcessRunning` in process-manager.js already handles this.
 *
 * ## API
 *
 *   safeStopServer({ pid, timeoutMs?, pollIntervalMs?, ...injections })
 *     → { stopped, usedLaunchctl, escalated, error }
 *
 * All external calls (plist existence, launchctl unload, isProcessRunning,
 * process.kill, sleep) are injectable for deterministic unit testing.
 * The production callers pass the real implementations from service.js
 * and process-manager.js.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import envConfig from "../env-config.js";
import { isProcessRunning } from "./process-manager.js";

const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents/com.dorkyrobot.katulong.plist",
);

/** Default ESRCH-tolerant kill wrapper. */
function defaultKill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code === "ESRCH") return; // already gone — not an error
    throw err;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop a server PID, handling launchd-managed processes correctly.
 *
 * @param {object} opts
 * @param {number|null} opts.pid           PID to stop. If null, no-op success.
 * @param {number}      [opts.timeoutMs]          How long to wait for graceful
 *   exit before SIGKILL. Defaults to envConfig.shutdownBudget, which is
 *   derived from DRAIN_TIMEOUT so it always exceeds the server's own
 *   self-imposed shutdown bound. A bespoke override here would silently
 *   reintroduce the `katulong update` race we hit on mac2019/mac2024 in
 *   v0.61.3 — only pass an override from tests that inject mock clocks.
 * @param {number}      [opts.pollIntervalMs=200] How often to poll isAlive.
 * @param {() => boolean}           [opts.plistExists] Injection: does the LaunchAgent plist exist?
 * @param {() => void}              [opts.unload]      Injection: launchctl unload.
 * @param {(pid: number) => boolean}[opts.isAlive]     Injection: is this PID currently alive?
 * @param {(pid: number, signal: string) => void} [opts.kill] Injection: send a signal.
 * @param {(ms: number) => Promise<void>} [opts.sleep] Injection: async sleep.
 *
 * @returns {Promise<{
 *   stopped: boolean,        // old PID is confirmed dead
 *   usedLaunchctl: boolean,  // we routed through launchctl unload
 *   escalated: boolean,      // we had to SIGKILL
 *   error: string|null,
 * }>}
 */
export async function safeStopServer({
  pid,
  timeoutMs = envConfig.shutdownBudget,
  pollIntervalMs = 200,
  plistExists,
  unload,
  isAlive = isProcessRunning,
  kill = defaultKill,
  sleep = defaultSleep,
} = {}) {
  // Lazy default resolution so tests don't need to import service.js.
  // service.js runs file I/O at module load (plist dir, etc.) which we
  // want to avoid in unit tests that only care about the decision logic.
  if (!plistExists) plistExists = () => existsSync(PLIST_PATH);
  if (!unload) {
    unload = async () => {
      const mod = await import("./commands/service.js");
      mod.launchctlUnload();
    };
  }

  if (pid == null) {
    return { stopped: true, usedLaunchctl: false, escalated: false, error: null };
  }

  const managedByLaunchd = plistExists();

  // Phase 1: tell the lifecycle manager (or the kernel) to stop the process.
  if (managedByLaunchd) {
    // launchctl unload is the ONLY safe way to stop a KeepAlive process.
    // SIGTERM here would trigger an immediate respawn.
    try {
      await unload();
    } catch (err) {
      // Non-fatal: fall through to polling. If unload failed but the process
      // is dead anyway, we'll see that below. If it's still alive, we'll
      // escalate to SIGKILL after the grace window.
    }
  } else {
    // No launchd supervisor — direct SIGTERM is safe.
    try {
      kill(pid, "SIGTERM");
    } catch (err) {
      if (err.code === "ESRCH") {
        // Process was already dead when we tried to signal it. That's
        // success, not failure — the goal was "make it stop existing"
        // and it doesn't exist. Do NOT retry, do NOT report an error.
        return {
          stopped: true,
          usedLaunchctl: false,
          escalated: false,
          error: null,
        };
      }
      return {
        stopped: false,
        usedLaunchctl: false,
        escalated: false,
        error: err.message,
      };
    }
  }

  // Phase 2: poll the SPECIFIC old PID until it exits or we hit timeout.
  // We do not poll isServerRunning() here — that's port-based and cannot
  // distinguish the old PID from a launchd respawn on the same port.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return {
        stopped: true,
        usedLaunchctl: managedByLaunchd,
        escalated: false,
        error: null,
      };
    }
    await sleep(pollIntervalMs);
  }

  // Phase 3: the old PID is still alive after the grace window. Escalate
  // to SIGKILL against the specific old PID — never a different PID, never
  // a port-based kill. If the PID died between the final isAlive poll and
  // the kill (ESRCH), that's still success: the goal was "make it stop
  // existing" and it doesn't exist.
  let escalationError = null;
  try {
    kill(pid, "SIGKILL");
  } catch (err) {
    if (err.code === "ESRCH") {
      return {
        stopped: true,
        usedLaunchctl: managedByLaunchd,
        escalated: true,
        error: null,
      };
    }
    escalationError = err.message;
  }

  // Brief settle, then confirm.
  await sleep(pollIntervalMs);
  const stillAlive = isAlive(pid);

  return {
    stopped: !stillAlive,
    usedLaunchctl: managedByLaunchd,
    escalated: true,
    error: stillAlive ? (escalationError || "process still alive after SIGKILL") : null,
  };
}
