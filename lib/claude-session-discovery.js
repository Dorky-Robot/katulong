/**
 * Claude session discovery — resolve `meta.claude.{uuid, cwd, startedAt}`
 * from the filesystem alone, no hooks required.
 *
 * Claude Code writes a per-pid JSON at `~/.claude/sessions/<pid>.json` when
 * it starts. The shape (observed 2026-04) is:
 *
 *   { pid, sessionId, cwd, startedAt, kind, entrypoint }
 *
 * This file is authoritative — Claude writes it itself, so there's no
 * ambiguity about which transcript belongs to which pane. That sidesteps
 * the `claude-transcript-discovery.js` dead ends: mtime-scan and lsof
 * both picked the wrong transcript during startup because Claude opens
 * prior sessions for compaction summaries. The per-pid JSON doesn't care
 * about opened file handles — it's a one-line record keyed to the pid.
 *
 * Resolution walks from a tmux pane pid down through its children with
 * `pgrep -P`, because the shell sits between the pane and the claude
 * process. We also probe the pane pid itself in case the user ran the
 * agent with `exec claude`. First candidate whose JSON exists and parses
 * with a valid UUID-shaped sessionId wins.
 *
 * Returning `null` is the expected "not yet" result while Claude is
 * booting or when the pane isn't running Claude — callers treat a
 * null result as "try again on the next tick."
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { UUID_RE } from "./claude-event-transform.js";
import { detectAgent } from "./agent-presence.js";
import { log } from "./log.js";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/**
 * Snapshot every running process as `{ pid, ppid }` via `ps -ax`.
 *
 * Why not `pgrep -P`? On macOS, `pgrep -P <parent>` silently returns no
 * results when the parent's child has rewritten its `process.title`
 * (e.g. Claude Code sets it to the SemVer string "2.1.114"). The same
 * relationship is reported correctly by `ps`, so we scan the full table
 * once and build the ppid index ourselves. Cost is a single fork per
 * call, identical to `pgrep`.
 */
function psSnapshot() {
  return new Promise((resolve) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid="], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const rows = stdout.trim().split("\n").map((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
        return { pid, ppid };
      }).filter(Boolean);
      resolve(rows);
    });
  });
}

/**
 * Collect pid + up to two generations of descendants using a single
 * `ps` snapshot. Two layers covers the pane → shell → claude chain and
 * the `exec claude` case where the pane pid itself is claude.
 */
async function collectCandidatePids(panePid, snapshotFn = psSnapshot) {
  const rows = await snapshotFn();
  const byParent = new Map();
  for (const { pid, ppid } of rows) {
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const seen = new Set([panePid]);
  const gen1 = byParent.get(panePid) || [];
  for (const p of gen1) seen.add(p);
  for (const p of gen1) {
    for (const gc of (byParent.get(p) || [])) seen.add(gc);
  }
  return [...seen];
}

async function readSessionFile(pid) {
  try {
    const raw = await readFile(join(SESSIONS_DIR, `${pid}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validRecord(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.sessionId !== "string" || !UUID_RE.test(data.sessionId)) return false;
  if (typeof data.cwd !== "string" || data.cwd.length === 0) return false;
  return true;
}

/**
 * Resolve Claude session details for a given tmux pane pid.
 *
 * @param {number | string} panePid - numeric pid of the tmux pane's shell
 * @param {{ readSession?: (pid: number) => Promise<object | null>,
 *           listChildren?: (pid: number) => Promise<number[]>,
 *           snapshot?: () => Promise<Array<{pid:number, ppid:number}>> }} [deps]
 *        - Test seams. Defaults use `ps -ax` and the real ~/.claude/sessions dir.
 *          `snapshot` overrides the ps call while keeping the real tree-walk
 *          logic; `listChildren` overrides the whole walk (used by existing
 *          tests that stub at the higher level).
 * @returns {Promise<{ uuid: string, cwd: string, startedAt: number } | null>}
 */
export async function discoverClaudeSession(panePid, deps = {}) {
  const pidNum = Number(panePid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) return null;

  const readSession = deps.readSession || readSessionFile;
  const listChildren = deps.listChildren
    || ((pid) => collectCandidatePids(pid, deps.snapshot));

  const candidates = await listChildren(pidNum);
  for (const pid of candidates) {
    const rec = await readSession(pid);
    if (!validRecord(rec)) continue;
    return {
      uuid: rec.sessionId,
      cwd: rec.cwd,
      startedAt: typeof rec.startedAt === "number" ? rec.startedAt : Date.now(),
    };
  }
  return null;
}

/**
 * Populate `meta.claude.{uuid, cwd, startedAt}` from Claude's per-pid
 * session file when Claude is running in the pane.
 *
 * Filesystem discovery removes the hook-install dependency: as long
 * as the user is running a current Claude Code build, `~/.claude/
 * sessions/<pid>.json` exists and carries the authoritative uuid.
 * That's what the frontend feed tile reads to open the transcript,
 * and the sparkle click resolves to a real feed instead of a picker.
 *
 * `cwd` is Claude's **launch** cwd, so it fixes file-link resolution
 * for the `cd worktree && claude` flow — the pane shell's cwd drifts
 * while Claude holds the pane, but Claude's process cwd is stable. It
 * does NOT follow a `--add-dir` switch or an in-process `/cd`; that
 * case needs Step 4 of `docs/file-link-worktree-resolution.md`.
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
 *  - Dedup on the full (uuid, cwd) tuple so `claude --resume` into a
 *    different worktree refreshes the cwd even though the uuid is
 *    unchanged.
 *
 * Lives here (in the Claude module) rather than in the generic
 * session-child-counter so the generic monitor loop doesn't have to
 * know about Claude-specific enrichment. The monitor calls this via
 * the generic `reconcileAgentPresence` result.
 *
 * @param {object} session  katulong Session
 * @param {string | null} currentCommand  tmux pane_current_command
 * @param {number | null} panePid  pid of the pane's top-level process
 * @param {{ discover?: typeof discoverClaudeSession }} [deps]
 * @returns {Promise<boolean>}  true iff meta.claude was written
 */
export async function reconcileClaudeEnrichment(session, currentCommand, panePid, deps = {}) {
  if (detectAgent(currentCommand) !== "claude") return false;
  if (!panePid) return false;

  const discover = deps.discover || discoverClaudeSession;
  const found = await discover(panePid);
  if (!found) return false;

  const existing = session.meta?.claude || {};
  if (existing.uuid === found.uuid && existing.cwd === found.cwd) return false;

  // The hook ingest path in app-routes.js also writes meta.claude and owns
  // `transcriptPath`. Preserve it across this write when the uuid is
  // unchanged — otherwise a new Claude session should start with a fresh
  // namespace since a stale transcriptPath would point at the old uuid.
  const next = {
    uuid: found.uuid,
    cwd: found.cwd,
    startedAt: found.startedAt,
  };
  if (existing.uuid === found.uuid && typeof existing.transcriptPath === "string") {
    next.transcriptPath = existing.transcriptPath;
  }

  try {
    session.setMeta("claude", next);
    return true;
  } catch (err) {
    log.warn("Failed to write discovered meta.claude", {
      session: session.name, error: err.message,
    });
    return false;
  }
}
