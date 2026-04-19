/**
 * Session pane monitor.
 *
 * Periodically inspects each alive session's tmux pane for two facts:
 *   1. The number of child processes running inside the pane's shell.
 *   2. The foreground command name (for coding-agent presence auto-detection).
 *
 * Both are relayed to clients via the transport bridge. Also reaps dead,
 * clientless sessions from the map so they don't linger.
 *
 * Agent presence is derived from tmux's own `pane_current_command` field
 * against the `lib/agent-presence.js` registry: tmux tracks the
 * tty-controlling foreground process per pane, so when the user runs
 * `claude` / `opencode` / … in the shell the field flips without any
 * pgrep walk or new process spawn. The same `list-panes` call we already
 * make for the pane pid carries this for free.
 *
 * This module owns `session.meta.agent` (presence) and is deliberately
 * harness-agnostic. Claude-specific enrichment (e.g. writing
 * `session.meta.claude.uuid` from `~/.claude/sessions/<pid>.json`)
 * lives in `lib/claude-session-discovery.js`; the monitor calls into
 * it as a black box — no Claude logic lives in this file.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { tmuxSocketArgs } from "./tmux.js";
import { detectAgent, isClaudeCommand } from "./agent-presence.js";
import { reconcileClaudeEnrichment } from "./claude-session-discovery.js";

const DEFAULT_INTERVAL_MS = 5000;

// Re-export isClaudeCommand for back-compat with callers / tests that
// only care about the Claude case. New code should call detectAgent()
// directly from `./agent-presence.js`.
export { isClaudeCommand };

/**
 * Inspect a tmux pane for its pid and foreground command name, then count
 * the shell's direct children via pgrep.
 *
 * Resolves to `{ childCount: 0, currentCommand: null, panePid: null }` on
 * any error so the monitoring loop never crashes on a transient tmux
 * hiccup. `panePid` is the numeric pid of the pane's top-level process
 * (usually the login shell), surfaced so downstream enrichment like
 * `discoverClaudeSession` can walk children without re-running `tmux
 * list-panes`.
 *
 * @param {string} tmuxName
 * @returns {Promise<{ childCount: number, currentCommand: string | null, panePid: number | null }>}
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
        if (err || !stdout.trim()) return resolve({ childCount: 0, currentCommand: null, panePid: null });
        // Only the first pane is inspected — katulong-managed sessions
        // always have exactly one pane. An externally-adopted multi-pane
        // session still resolves to the first pane's foreground.
        const firstLine = stdout.trim().split("\n")[0];
        const spaceIdx = firstLine.indexOf(" ");
        const panePidStr = spaceIdx === -1 ? firstLine : firstLine.slice(0, spaceIdx);
        const currentCommand = spaceIdx === -1 ? null : firstLine.slice(spaceIdx + 1).trim() || null;
        if (!/^\d+$/.test(panePidStr)) return resolve({ childCount: 0, currentCommand, panePid: null });
        const panePid = Number(panePidStr);
        execFile("pgrep", ["-P", panePidStr], (err2, stdout2) => {
          if (err2 || !stdout2.trim()) return resolve({ childCount: 0, currentCommand, panePid });
          const children = stdout2.trim().split("\n").filter((p) => /^\d+$/.test(p));
          resolve({ childCount: children.length, currentCommand, panePid });
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
 * Reconcile `meta.agent` against the latest tmux `pane_current_command`.
 * Writes `{ kind, running: true, detectedAt }` when an agent is detected,
 * clears the namespace when the foreground command is no longer a
 * recognized agent.
 *
 * Returns `true` if the session's meta changed as a result, `false`
 * otherwise — callers use this to decide whether to broadcast. The
 * internal `setMeta` path already fires its own `onChange`, so the
 * monitor loop doesn't need to relay a separate message.
 *
 * Note: a kind change (e.g. user exits claude and starts opencode in
 * the same pane without the pane ever going idle) is treated as a
 * single transition — one clear of the old kind, one write of the new.
 *
 * @param {object} session  - katulong Session
 * @param {string | null} currentCommand
 * @returns {boolean}
 */
export function reconcileAgentPresence(session, currentCommand) {
  const nextKind = detectAgent(currentCommand);
  const current = (session.meta && session.meta.agent) ? session.meta.agent : null;
  const prevKind = current && current.running ? current.kind : null;

  if (nextKind === prevKind) return false;

  if (nextKind) {
    try {
      session.setMeta("agent", {
        kind: nextKind,
        running: true,
        detectedAt: Date.now(),
      });
      return true;
    } catch (err) {
      log.warn("Failed to mark agent running on session", {
        session: session.name, kind: nextKind, error: err.message,
      });
      return false;
    }
  }

  // No agent in the pane anymore — drop the namespace entirely. The
  // per-harness enrichment namespace (e.g. `meta.claude.uuid`) lives
  // in a separate key and is unaffected; a feed tile that resolved
  // against `meta.claude.uuid` keeps resolving after Claude quits.
  if (!current) return false;
  try {
    session.setMeta("agent", null);
    return true;
  } catch (err) {
    log.warn("Failed to clear agent presence on session", {
      session: session.name, error: err.message,
    });
    return false;
  }
}

/**
 * Start a periodic monitor that:
 *  1. Reaps dead, clientless sessions from the map.
 *  2. Inspects alive sessions' panes for child count + foreground command.
 *  3. Relays `child-count-update` and reconciles `meta.agent`.
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
  // Per-session in-flight guard. Prevents a slow tmux/pgrep/ps on one
  // session from piling up overlapping ticks — if the previous tick for
  // a session hasn't settled, we skip this tick for that session only
  // and let the others proceed.
  const inFlight = new Set();

  async function tickSession(name, session) {
    if (!session.alive) {
      if (!tracker.hasClients(name)) {
        sessions.delete(name);
        log.info("Reaped dead session", { session: name });
      }
      return;
    }
    const { childCount, currentCommand, panePid } = await inspectTmuxPane(session.tmuxName);
    session.updateChildCount(childCount);
    bridge.relay({ type: "child-count-update", session: name, count: childCount });
    // Agent presence flips trigger a session.setMeta call, which itself
    // fires onChange → session-updated broadcast; nothing to relay here.
    reconcileAgentPresence(session, currentCommand);
    // When Claude is running, try to enrich meta.claude from the
    // per-pid session file Claude writes to disk. Hook-free so the
    // sparkle tile opens a feed without an installer step.
    await reconcileClaudeEnrichment(session, currentCommand, panePid);
  }

  const timer = setInterval(() => {
    // Fan out per-session. Each session ticks independently — a slow
    // tmux call on one pane can't stall every other session's update.
    // The interval itself is what bounds concurrency (≥1 interval
    // between ticks for any given session), and the inFlight guard
    // absorbs the tail case where one session runs longer than the
    // interval.
    for (const [name, session] of [...sessions]) {
      if (inFlight.has(name)) continue;
      inFlight.add(name);
      Promise.resolve()
        .then(() => tickSession(name, session))
        .catch((err) => log.warn("child-count monitor tick failed", {
          session: name, error: err.message,
        }))
        .finally(() => inFlight.delete(name));
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
