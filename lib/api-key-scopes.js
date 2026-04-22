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
 */

export const SCOPE_FULL = "full";
export const SCOPE_MINT_SESSION = "mint-session";

export const API_KEY_SCOPES = new Set([
  SCOPE_FULL,
  SCOPE_MINT_SESSION,
]);

export const DEFAULT_API_KEY_SCOPES = Object.freeze([SCOPE_FULL]);
