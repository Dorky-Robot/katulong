/**
 * Shared test helper for writing auth state as per-entity files.
 *
 * All integration tests that need to pre-seed auth state should use this
 * helper instead of writing a monolithic JSON file directly.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Write auth state as per-entity files into the given directory.
 *
 * @param {string} dir - Data directory (e.g. a temp dir from mkdtempSync)
 * @param {object} stateObj - Auth state object with user, credentials, sessions, setupTokens
 */
export function writeAuthFixture(dir, stateObj) {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  mkdirSync(join(dir, "setup-tokens"), { recursive: true });

  if (stateObj.user) {
    writeFileSync(
      join(dir, "user.json"),
      JSON.stringify(stateObj.user),
      { mode: 0o600 }
    );
  }

  for (const cred of stateObj.credentials || []) {
    writeFileSync(
      join(dir, "credentials", `${cred.id}.json`),
      JSON.stringify(cred),
      { mode: 0o600 }
    );
  }

  for (const [token, session] of Object.entries(stateObj.sessions || {})) {
    writeFileSync(
      join(dir, "sessions", `${token}.json`),
      JSON.stringify({ token, ...session }),
      { mode: 0o600 }
    );
  }

  for (const tok of stateObj.setupTokens || []) {
    writeFileSync(
      join(dir, "setup-tokens", `${tok.id}.json`),
      JSON.stringify(tok),
      { mode: 0o600 }
    );
  }
}
