/**
 * Bearer API key resolution for HTTP requests.
 *
 * Extracted from server.js so tests can share the same code path without
 * pulling in the full HTTP server. Given a request and an AuthState, finds
 * the API key, stashes auth metadata on the request, and returns a result
 * object matching the rest of the `isAuthenticated` contract.
 *
 * Stashed fields (read by lib/routes/middleware.js):
 * - req._apiKeyAuth — true if Bearer auth succeeded
 * - req._apiKeyId — the id of the matching API key record
 * - req._apiKeyScopes — the normalized scope array from the matching record
 */

import { DEFAULT_API_KEY_SCOPES } from "./api-key-scopes.js";

/**
 * Extract a Bearer token from an Authorization header, or null if absent.
 */
export function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== "string") return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Try to authenticate a request via Bearer API key. Mutates `req` with the
 * auth metadata on success. Returns:
 *   { matched: true, keyData } — key valid, req has been stamped
 *   { matched: false }         — no Bearer header (caller should try cookie)
 *   null                       — Bearer header present but invalid key
 *
 * A null return means "Bearer header present but bogus" — the caller must
 * reject auth outright rather than falling through to cookie auth, so a
 * leaked/revoked key can't be chased with a session cookie on the same
 * request.
 */
export function authenticateBearerKey(req, state) {
  const token = extractBearerToken(req.headers?.authorization);
  if (token === null) return { matched: false };
  if (!state) return null;
  const keyData = state.findApiKey(token);
  if (!keyData) return null;
  req._apiKeyAuth = true;
  req._apiKeyId = keyData.id;
  req._apiKeyScopes = Array.isArray(keyData.scopes) && keyData.scopes.length
    ? [...keyData.scopes]
    : [...DEFAULT_API_KEY_SCOPES];
  return { matched: true, keyData };
}
