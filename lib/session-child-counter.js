/**
 * Session child-count monitor.
 *
 * Periodically counts the number of child processes running inside each
 * alive session's tmux pane and relays the result via the transport bridge.
 * Also reaps dead, clientless sessions from the map so they don't linger.
 *
 * Why it lives in its own module
 * - The monitoring loop has nothing to do with session lifecycle or tmux
 *   control-mode I/O — it's a passive observer that polls tmux and pgrep
 *   on a timer. Extracting it keeps session-manager.js focused on session
 *   creation, attachment, and the bridge contract.
 * - Pure function `countTmuxPaneProcesses` is now trivially testable
 *   (accepts a tmuxName, returns a promise of number) with no setup.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { tmuxSocketArgs } from "./tmux.js";

const DEFAULT_INTERVAL_MS = 5000;

/**
 * Count the number of child processes running inside a tmux pane's shell.
 *
 * Resolves to 0 on any error (missing pane, pgrep failure) — the count is
 * advisory and must not crash the monitoring loop.
 *
 * @param {string} tmuxName
 * @returns {Promise<number>}
 */
export function countTmuxPaneProcesses(tmuxName) {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      [...tmuxSocketArgs(), "list-panes", "-t", tmuxName, "-F", "#{pane_pid}"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(0);
        const panePid = stdout.trim().split("\n")[0];
        if (!/^\d+$/.test(panePid)) return resolve(0);
        execFile("pgrep", ["-P", panePid], (err2, stdout2) => {
          if (err2 || !stdout2.trim()) return resolve(0);
          const children = stdout2.trim().split("\n").filter((p) => /^\d+$/.test(p));
          resolve(children.length);
        });
      }
    );
  });
}

/**
 * Start a periodic monitor that:
 *  1. Reaps dead, clientless sessions from the map.
 *  2. Counts children for alive sessions and relays `child-count-update`.
 *
 * Returns a stop() function that clears the interval.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.sessions - The session manager's internal map.
 * @param {{ hasClients: (name: string) => boolean }} opts.tracker - Client tracker.
 * @param {{ relay: (msg: object) => void }} opts.bridge - Transport bridge.
 * @param {number} [opts.intervalMs=5000]
 * @returns {{ stop: () => void }}
 */
export function startChildCountMonitor({ sessions, tracker, bridge, intervalMs = DEFAULT_INTERVAL_MS }) {
  const timer = setInterval(async () => {
    for (const [name, session] of [...sessions]) {
      if (!session.alive) {
        // Reap dead sessions that have no attached clients
        if (!tracker.hasClients(name)) {
          sessions.delete(name);
          log.info("Reaped dead session", { session: name });
        }
        continue;
      }
      const count = await countTmuxPaneProcesses(session.tmuxName);
      session.updateChildCount(count);
      bridge.relay({ type: "child-count-update", session: name, count });
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
