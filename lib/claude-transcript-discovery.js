/**
 * Claude transcript discovery — locate the "Claude session running here right now"
 * by looking at the filesystem directly, without needing hooks to have fired.
 *
 * Claude Code writes one JSONL file per session to:
 *   ~/.claude/projects/<slug(cwd)>/<uuid>.jsonl
 *
 * The slug rule (observed, 2026-04): every non-alphanumeric character in the
 * absolute cwd is replaced with "-". So `/Users/x/foo_bar/.claude` becomes
 * `-Users-x-foo-bar--claude`. Note the double hyphen where `/.` collapses —
 * leading slash AND the dot both map to `-`. This is lossy (underscore and
 * hyphen in the source collide in the slug), but the loss only matters
 * when two active projects on the same machine slug to the same string; we
 * tolerate that collision because the user can click sparkle again after
 * starting the right Claude.
 *
 * We don't call Claude's CLI to ask where its projects live — that would
 * be heavy and requires the CLI to be installed. We just read the
 * directory. If Claude ever changes the slug rule, this module is the one
 * place that needs updating.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Slug a cwd the way Claude Code does on disk.
 * Every non-alphanumeric rune becomes `-`.
 */
export function slugifyCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Path to the Claude project directory for a cwd, given a home override.
 */
export function projectDirFor(cwd, { home = homedir() } = {}) {
  const slug = slugifyCwd(cwd);
  if (!slug) return null;
  return join(home, ".claude", "projects", slug);
}

/**
 * Find the most-recently-modified transcript for `cwd`. When `maxAgeMs` is
 * set, returns null if no transcript has been touched within that window —
 * so we don't hand back yesterday's stale UUID for a pane where Claude
 * isn't actually running.
 *
 * @returns {{ uuid: string, transcriptPath: string, mtimeMs: number } | null}
 */
export function resolveLatestTranscript({ cwd, home = homedir(), maxAgeMs = null } = {}) {
  const dir = projectDirFor(cwd, { home });
  if (!dir || !existsSync(dir)) return null;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  const now = Date.now();
  let best = null;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const uuid = name.slice(0, -".jsonl".length);
    if (!UUID_RE.test(uuid)) continue;

    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    if (maxAgeMs !== null && now - st.mtimeMs > maxAgeMs) continue;

    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { uuid, transcriptPath: full, mtimeMs: st.mtimeMs };
    }
  }

  return best;
}

/**
 * Validate a UUID string. Kept here (not imported from elsewhere) because
 * this module is the one that mints UUIDs into the rest of the system,
 * and keeping the shape check local makes the contract obvious.
 */
export function isClaudeUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}
