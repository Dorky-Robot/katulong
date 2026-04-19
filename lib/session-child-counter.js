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
 * This module owns `session.meta.agent` (presence). Hook-driven
 * enrichment like `session.meta.claude.uuid` lives under a separate
 * per-harness namespace written by the hook route — this monitor
 * never touches it.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";
import { tmuxSocketArgs } from "./tmux.js";
import { detectAgent, isClaudeCommand } from "./agent-presence.js";
import { discoverClaudeSession } from "./claude-session-discovery.js";

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
 * Deprecated alias — preserves the old name for any caller that
 * imports it directly. Prefer `reconcileAgentPresence`. Safe to
 * remove once external consumers migrate.
 */
export const reconcileClaudePresence = reconcileAgentPresence;

/**
 * Populate `meta.claude.{uuid, startedAt}` from Claude's per-pid
 * session file when Claude is running in the pane.
 *
 * Filesystem discovery removes the hook-install dependency: as long
 * as the user is running a current Claude Code build, `~/.claude/
 * sessions/<pid>.json` exists and carries the authoritative uuid.
 * That's what the frontend feed tile reads to open the transcript,
 * and the sparkle click resolves to a real feed instead of a picker.
 *
 * Invariants:
 *  - Only runs when `detectAgent(currentCommand) === "claude"`.
 *  - Probes every tick Claude is running. Cost is one `ps -ax` + one
 *    `readFile` on the matching pid's session json — negligible next
 *    to the existing `tmux list-panes` + `pgrep` the monitor already
 *    does. The periodic probe is what lets the server self-heal a
 *    stale persisted uuid (e.g. after a restart where a previous
 *    build's discovery wrote the wrong uuid).
 *  - Never clears `meta.claude` on exit — preserving the uuid after
 *    Claude quits is what lets a watched feed tile keep resolving
 *    the on-disk transcript. Stale uuids are replaced only when
 *    discovery returns a new value, i.e. while Claude is alive.
 *
 * @param {object} session  katulong Session
 * @param {string | null} currentCommand  tmux pane_current_command
 * @param {number | null} panePid  pid of the pane's top-level process
 * @param {boolean} _presenceChanged  reserved for future diff logic
 * @param {{ discover?: typeof discoverClaudeSession }} [deps]
 * @returns {Promise<boolean>}  true iff meta.claude was written
 */
export async function reconcileClaudeEnrichment(
  session, currentCommand, panePid, _presenceChanged, deps = {}
) {
  if (detectAgent(currentCommand) !== "claude") return false;
  if (!panePid) return false;

  const discover = deps.discover || discoverClaudeSession;
  const found = await discover(panePid);
  if (!found) return false;

  const existing = session.meta?.claude?.uuid ?? null;
  if (existing === found.uuid) return false;

  try {
    session.setMeta("claude", {
      uuid: found.uuid,
      startedAt: found.startedAt,
    });
    return true;
  } catch (err) {
    log.warn("Failed to write discovered meta.claude", {
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
  const timer = setInterval(async () => {
    for (const [name, session] of [...sessions]) {
      if (!session.alive) {
        if (!tracker.hasClients(name)) {
          sessions.delete(name);
          log.info("Reaped dead session", { session: name });
        }
        continue;
      }
      const { childCount, currentCommand, panePid } = await inspectTmuxPane(session.tmuxName);
      session.updateChildCount(childCount);
      bridge.relay({ type: "child-count-update", session: name, count: childCount });
      // Agent presence flips trigger a session.setMeta call, which itself
      // fires onChange → session-updated broadcast; nothing to relay here.
      const presenceChanged = reconcileAgentPresence(session, currentCommand);
      // When Claude is running, try to enrich meta.claude from the
      // per-pid session file Claude writes to disk. Hook-free so the
      // sparkle tile opens a feed without an installer step.
      await reconcileClaudeEnrichment(session, currentCommand, panePid, presenceChanged);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
