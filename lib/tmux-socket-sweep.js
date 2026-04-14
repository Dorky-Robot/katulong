/**
 * Sweep orphan tmux socket files from /tmp/tmux-$UID/.
 *
 * Used in two places:
 *   - test harness boot (`test/helpers/setup-env.js`) for
 *     `katulong-test-<pid>` sockets accumulated by SIGKILLed or
 *     timed-out test processes.
 *   - `katulong tmux-sweep` CLI / brew post_install, so upgrading the
 *     package reaps orphans from prior dev activity.
 *
 * There are two distinct leak modes for PID-scoped tmux sockets:
 *
 *   A. Dead socket, no server. Either `kill-server` ran but didn't finish
 *      unlinking, or the server crashed outright. The file remains.
 *
 *   B. Orphaned but alive. The creator process was SIGKILLed (pre-push
 *      hook timeout, CI runner timeout, OOM), so its `process.on("exit")`
 *      never ran — but the detached tmux anchor server kept running.
 *      Observed on a dev machine: anchors from test PIDs 3+ days dead,
 *      still listening. A probe-based sweep ("does tmux respond?") sees
 *      these as alive and leaves them forever.
 *
 * The socket name encodes its creator: `<prefix><pid>`. If that PID is
 * no longer alive, the socket is an orphan in both modes above. We kill
 * the server (best-effort, reaps mode B) and unlink (catches mode A and
 * finishes mode B). If the PID is alive we leave everything alone.
 *
 * This is also faster than the probe approach — `process.kill(pid, 0)`
 * is a syscall rather than a spawn-tmux-per-socket, so sweeping 16k
 * entries takes milliseconds rather than minutes.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Directory tmux uses for per-user sockets. Honors TMUX_TMPDIR, falls
 * back to /tmp (tmux's own default). Keep in sync with tmux's behavior
 * in `server.c:server_start`.
 */
export function tmuxSocketDir() {
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return `${base}/tmux-${process.getuid()}`;
}

/**
 * Remove orphaned tmux socket files whose basename matches
 * `<prefix><pid>` where `<pid>` is no longer a live process.
 *
 * Only sockets that match this exact shape are considered — anything
 * else (including sockets that match the prefix but have non-numeric
 * suffixes) is left alone. This makes the sweep safe to run against
 * shared directories without risk of clobbering unrelated state.
 *
 * Returns the number of sockets removed. Never throws.
 */
export function sweepOrphanTmuxSockets(prefix) {
  const dir = tmuxSocketDir();
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  const pidRe = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
  let removed = 0;
  for (const name of entries) {
    const m = pidRe.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (isProcessAlive(pid)) continue;

    // Best-effort kill-server to evict any tmux anchor that outlived
    // the test process (leak mode B). If there's no server listening
    // — leak mode A — this fails and we move on.
    try {
      execFileSync("tmux", ["-L", name, "kill-server"], {
        stdio: "ignore",
        timeout: 500,
      });
    } catch {}

    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      // Socket vanished between readdir and unlink, or we lack
      // permission — either way, not our problem to resolve here.
    }
  }
  return removed;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
