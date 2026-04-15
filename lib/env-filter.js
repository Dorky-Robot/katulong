/**
 * Environment variable filtering for tmux sessions.
 *
 * Sensitive variables must not be visible to terminal users — leaking
 * SETUP_TOKEN would allow session escalation.
 */

export const SENSITIVE_ENV_VARS = new Set([
  "SETUP_TOKEN",
  "CLAUDECODE", // Prevent nested Claude Code sessions
  // Diagnostic/debug flags — filter so shell users can't observe that
  // the server is running with drift logging on (information disclosure).
  "KATULONG_DRIFT_LOG",
  "KATULONG_DRIFT_DEBUG",
  // tmux server state — TMUX and TMUX_PANE are set by tmux itself when it
  // spawns the pane's shell. If katulong runs inside an outer tmux (common
  // with SSH + tmux, or `katulong-stage` launched from a tmux window), the
  // outer values arrive via process.env and our wrapper's `export` line
  // clobbers the inner tmux's values. That breaks MC1f pane-to-session
  // matching — hook payloads stamp the outer pane id and
  // `applyClaudeMetaFromHook` no-ops because it can't find the session.
  // See docs/session-meta.md.
  "TMUX",
  "TMUX_PANE",
  "TMUX_TMPDIR",
]);

/**
 * Returns a copy of process.env with all sensitive variables removed.
 * Does not mutate process.env.
 */
export function getSafeEnv() {
  const safe = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SENSITIVE_ENV_VARS.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}
