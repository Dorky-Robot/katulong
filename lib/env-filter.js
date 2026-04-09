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
