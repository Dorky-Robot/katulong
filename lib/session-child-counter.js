/**
 * Session pane monitor.
 *
 * Periodically inspects each alive session's tmux pane for two facts:
 *   1. The number of child processes running inside the pane's shell.
 *   2. The foreground command name (for Claude presence auto-detection).
 *
 * Both are relayed to clients via the transport bridge. Also reaps dead,
 * clientless sessions from the map so they don't linger.
 *
 * Claude presence is derived from tmux's own `pane_current_command` field:
 * tmux tracks the tty-controlling foreground process per pane, so when the
 * user runs `claude` in the shell the field flips to `claude` without any
 * pgrep walk or new process spawn. The same `list-panes` call we already
 * make for the pane pid carries this for free.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { tmuxSocketArgs } from "./tmux.js";

const DEFAULT_INTERVAL_MS = 5000;

// Foreground commands that mean "a Claude Code session is running in this
// pane." Matching falls into two cases:
//
//   1. The binary basename (`claude`, `claude-code`) — what you'd expect,
//      but only hits on systems where Claude Code hasn't called
//      `process.title` yet (brief startup window) or on distros that
//      expose the exec name via tmux.
//   2. A SemVer string (e.g. `2.1.109`, `2.2.0-beta.1`) — Claude Code sets
//      `process.title = <version>` at startup. On macOS (and BSDs), tmux's
//      `pane_current_command` reads `kinfo_proc.p_comm` / ucomm, which
//      reflects the *current* title, not the original exec name. So for a
//      live Claude Code session on macOS, the thing you see in tmux is
//      literally the version number — `claude` never appears.
//
// The SemVer matcher is strict enough that real-world command names
// don't collide: no well-known CLI sets its process title to a dotted
// three-component numeric string. Two-component versions, pids, and IP
// fragments are all rejected.
const CLAUDE_COMMAND_NAMES = new Set(["claude", "claude-code"]);
const SEMVER_TITLE_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

/**
 * True when a tmux `pane_current_command` value represents a running Claude
 * Code session. Null / empty / unrelated commands return false.
 *
 * @param {string | null | undefined} cmd
 * @returns {boolean}
 */
export function isClaudeCommand(cmd) {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (CLAUDE_COMMAND_NAMES.has(cmd)) return true;
  return SEMVER_TITLE_RE.test(cmd);
}

/**
 * Inspect a tmux pane for its pid and foreground command name, then count
 * the shell's direct children via pgrep.
 *
 * Resolves to `{ childCount: 0, currentCommand: null }` on any error so the
 * monitoring loop never crashes on a transient tmux hiccup.
 *
 * @param {string} tmuxName
 * @returns {Promise<{ childCount: number, currentCommand: string | null }>}
 */
export function inspectTmuxPane(tmuxName) {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      [
        ...tmuxSocketArgs(),
        "list-panes", "-t", tmuxName,
        "-F", "#{pane_pid} #{pane_current_command}",
      ],
      { timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ childCount: 0, currentCommand: null });
        // Only the first pane is inspected — katulong-managed sessions
        // always have exactly one pane. An externally-adopted multi-pane
        // session still resolves to the first pane's foreground.
        const firstLine = stdout.trim().split("\n")[0];
        const spaceIdx = firstLine.indexOf(" ");
        const panePid = spaceIdx === -1 ? firstLine : firstLine.slice(0, spaceIdx);
        const currentCommand = spaceIdx === -1 ? null : firstLine.slice(spaceIdx + 1).trim() || null;
        if (!/^\d+$/.test(panePid)) return resolve({ childCount: 0, currentCommand });
        execFile("pgrep", ["-P", panePid], (err2, stdout2) => {
          if (err2 || !stdout2.trim()) return resolve({ childCount: 0, currentCommand });
          const children = stdout2.trim().split("\n").filter((p) => /^\d+$/.test(p));
          resolve({ childCount: children.length, currentCommand });
        });
      }
    );
  });
}

/**
 * Back-compat shim: callers that only want the child count still get a
 * plain number. Kept so existing tests and external probes keep working.
 *
 * @param {string} tmuxName
 * @returns {Promise<number>}
 */
export function countTmuxPaneProcesses(tmuxName) {
  return inspectTmuxPane(tmuxName).then((r) => r.childCount);
}

/**
 * Reconcile `meta.claude.running` on the session against the latest tmux
 * `pane_current_command` reading. Preserves any hook-written fields
 * (`uuid`, `startedAt`) that live in the same namespace.
 *
 * Returns `true` if the session's meta changed as a result, `false`
 * otherwise — callers use this to decide whether to broadcast. The
 * internal `setMeta` path already fires its own `onChange`, so the
 * monitor loop doesn't need to relay a separate message.
 *
 * @param {object} session  - katulong Session
 * @param {string | null} currentCommand
 * @returns {boolean}
 */
export function reconcileClaudePresence(session, currentCommand) {
  const nowRunning = isClaudeCommand(currentCommand);
  const current = (session.meta && session.meta.claude) ? session.meta.claude : null;
  const wasRunning = !!(current && current.running);

  if (nowRunning === wasRunning) return false;

  if (nowRunning) {
    const next = { ...(current || {}), running: true, detectedAt: Date.now() };
    try {
      session.setMeta("claude", next);
      return true;
    } catch (err) {
      log.warn("Failed to mark claude running on session", {
        session: session.name, error: err.message,
      });
      return false;
    }
  }

  // Claude stopped running in the pane. Drop the detection-owned keys
  // but keep anything the hook ingest wrote (`uuid`, `startedAt`) so a
  // still-open feed tile can keep resolving to the right topic.
  if (!current) return false;
  const next = { ...current };
  delete next.running;
  delete next.detectedAt;
  try {
    session.setMeta("claude", Object.keys(next).length > 0 ? next : null);
    return true;
  } catch (err) {
    log.warn("Failed to clear claude running on session", {
      session: session.name, error: err.message,
    });
    return false;
  }
}

/**
 * Start a periodic monitor that:
 *  1. Reaps dead, clientless sessions from the map.
 *  2. Inspects alive sessions' panes for child count + foreground command.
 *  3. Relays `child-count-update` and reconciles `meta.claude.running`.
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
        if (!tracker.hasClients(name)) {
          sessions.delete(name);
          log.info("Reaped dead session", { session: name });
        }
        continue;
      }
      const { childCount, currentCommand } = await inspectTmuxPane(session.tmuxName);
      session.updateChildCount(childCount);
      bridge.relay({ type: "child-count-update", session: name, count: childCount });
      // Claude presence flips trigger a session.setMeta call, which itself
      // fires onChange → session-updated broadcast; nothing to relay here.
      reconcileClaudePresence(session, currentCommand);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
