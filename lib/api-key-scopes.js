/**
 * API key scopes — a small closed set.
 *
 * Scopes let operators issue narrowly-authorized API keys. A key with the
 * "full" scope is identical to a legacy, pre-scope key (bypasses CSRF when
 * the Bearer header is present, and any protected route accepts it). Narrow
 * scopes like "mint-session" are only accepted by routes that opt-in via
 * the `requireScope(...)` middleware; default-deny applies elsewhere.
 *
 * The set is intentionally closed — unknown scope strings are dropped at
 * `addApiKey` time so bad client input can't leak into persisted state.
 *
 * **Stability contract:** scope strings are externally visible identifiers —
 * they are persisted in `auth-state.json`, returned by `GET /api/api-keys`,
 * sent by clients to `POST /api/api-keys`, and documented in
 * `docs/federation-setup.md` as the thing an operator types on the command
 * line. They cannot be renamed without a persisted-state migration AND a
 * coordinated update of every hub that issued keys against them. Add new
 * scopes freely; never rename an existing one.
 */

export const SCOPE_FULL = "full";
export const SCOPE_MINT_SESSION = "mint-session";

export const API_KEY_SCOPES = new Set([
  SCOPE_FULL,
  SCOPE_MINT_SESSION,
]);

export const DEFAULT_API_KEY_SCOPES = Object.freeze([SCOPE_FULL]);

/**
 * Normalize scope input to a valid, de-duplicated array of known scopes.
 * Silently drops unknowns — use this on the data-model side for defense in
 * depth. For user-facing validation (reject unknowns with 400), use
 * validateScopes instead.
 */
export function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return [...DEFAULT_API_KEY_SCOPES];
  const filtered = scopes.filter(s => typeof s === "string" && API_KEY_SCOPES.has(s));
  if (filtered.length === 0) return [...DEFAULT_API_KEY_SCOPES];
  return [...new Set(filtered)];
}

/**
 * Validate user-supplied scope input. Returns `{valid, normalized, unknown}`
 * so a route handler can reject unknown scopes with a specific 400 instead
 * of silently dropping them.
 *
 * - `valid` is false iff `scopes` is non-empty AND contains any unknown
 *   entries (bad type or unknown name). An empty/missing input is valid and
 *   maps to the default scopes.
 * - `normalized` is the filtered, de-duplicated set of known scopes, or the
 *   default scopes if input was empty/missing.
 * - `unknown` lists the rejected strings so the caller can echo them back.
 */
export function validateScopes(scopes) {
  if (scopes === undefined || scopes === null) {
    return { valid: true, normalized: [...DEFAULT_API_KEY_SCOPES], unknown: [] };
  }
  if (!Array.isArray(scopes)) {
    return { valid: false, normalized: [...DEFAULT_API_KEY_SCOPES], unknown: [String(scopes)] };
  }
  const unknown = [];
  const known = [];
  for (const s of scopes) {
    if (typeof s === "string" && API_KEY_SCOPES.has(s)) known.push(s);
    else unknown.push(typeof s === "string" ? s : String(s));
  }
  if (unknown.length > 0) {
    return { valid: false, normalized: [...new Set(known)], unknown };
  }
  if (known.length === 0) {
    return { valid: true, normalized: [...DEFAULT_API_KEY_SCOPES], unknown: [] };
  }
  return { valid: true, normalized: [...new Set(known)], unknown: [] };
}
