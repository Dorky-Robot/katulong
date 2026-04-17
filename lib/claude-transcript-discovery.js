/**
 * Claude transcript discovery — map a cwd to the on-disk slug Claude Code uses.
 *
 * Claude Code writes one JSONL file per session to:
 *   ~/.claude/projects/<slug(cwd)>/<uuid>.jsonl
 *
 * The slug rule (observed, 2026-04): every non-alphanumeric character in the
 * absolute cwd is replaced with "-". So `/Users/x/foo_bar/.claude` becomes
 * `-Users-x-foo-bar--claude`. Note the double hyphen where `/.` collapses —
 * leading slash AND the dot both map to `-`. This is lossy (underscore and
 * hyphen in the source collide in the slug), but the loss only matters
 * when two active projects on the same machine slug to the same string; in
 * that case the user would hit the `{ uuid, cwd }` path explicitly and we
 * resolve correctly.
 *
 * This module used to export `resolveLatestTranscript` (an mtime heuristic
 * that picked the newest-modified .jsonl in a cwd) and then, briefly, a
 * live-process lsof scan of the pane's claude PID. Both picked the wrong
 * transcript in common cases: Claude Code keeps multiple JSONLs open during
 * startup (it reads prior sessions to build compaction summaries), so the
 * filesystem — whether queried by mtime or by lsof — cannot tell us which
 * session is the user's current one. The SessionStart hook is the only
 * reliable signal; see `lib/routes/claude-feed-routes.js`.
 */

/**
 * Slug a cwd the way Claude Code does on disk.
 * Every non-alphanumeric rune becomes `-`.
 */
export function slugifyCwd(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}
