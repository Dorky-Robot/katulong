/**
 * Environment variable filtering for PTY sessions.
 *
 * Sensitive variables must not be visible to terminal users — leaking
 * SSH_PASSWORD or SETUP_TOKEN would allow session escalation.
 */

export const SENSITIVE_ENV_VARS = new Set([
  "SSH_PASSWORD",
  "SETUP_TOKEN",
  "KATULONG_NO_AUTH",
  "CLAUDECODE", // Prevent nested Claude Code sessions
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
