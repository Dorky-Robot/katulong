/**
 * Route middleware factories
 *
 * Wraps route handlers with authentication, CSRF, and scope checks. Extracted
 * from lib/routes.js (Tier 3.4). The middleware is a factory because it
 * closes over the server's `isAuthenticated` and `json` helpers.
 *
 * Scope model: an API key carries one or more scopes (see api-key-scopes.js).
 * Cookie/localhost auth is treated as full access. Bearer auth with the
 * "full" scope is likewise unconstrained. Narrow-scope Bearer keys are
 * default-denied inside `auth()` — a route accepts a narrow scope only if
 * it's wrapped in `requireScope(...)`. This means adding a new narrow scope
 * cannot accidentally grant access to any existing route.
 *
 * Composition: `auth(requireScope("mint-session")(handler))`. `requireScope`
 * returns the inner handler tagged with a non-enumerable `_acceptedScopes`
 * property; `auth` reads that tag to know which scopes to accept. Ordering
 * is fixed: requireScope must be nested inside auth.
 */

import { loadState } from "../auth.js";
import { isLocalRequest } from "../access-method.js";
import { validateCsrfToken } from "../http-util.js";
import { SCOPE_FULL } from "../api-key-scopes.js";

const ACCEPTED_SCOPES = Symbol("acceptedScopes");

function requestScopes(req) {
  // Cookie/localhost auth has no scope record — treat as full access.
  if (!req._apiKeyAuth) return [SCOPE_FULL];
  return Array.isArray(req._apiKeyScopes) && req._apiKeyScopes.length
    ? req._apiKeyScopes
    : [SCOPE_FULL];
}

/**
 * @param {object} ctx
 * @param {(req: object) => boolean} ctx.isAuthenticated
 * @param {(res: object, status: number, body: object) => void} ctx.json
 * @returns {{ auth: Function, csrf: Function, requireScope: Function }}
 */
export function createMiddleware(ctx) {
  const { isAuthenticated, json } = ctx;

  function auth(handler) {
    const accepted = handler[ACCEPTED_SCOPES] || [SCOPE_FULL];
    return async (req, res, param) => {
      if (!isAuthenticated(req)) {
        return json(res, 401, { error: "Authentication required" });
      }
      const scopes = requestScopes(req);
      if (!scopes.some(s => accepted.includes(s))) {
        return json(res, 403, { error: "Insufficient scope" });
      }
      return handler(req, res, param);
    };
  }

  function csrf(handler) {
    return async (req, res, param) => {
      // Skip CSRF for API key auth (Bearer token) and localhost
      if (!isLocalRequest(req) && !req._apiKeyAuth) {
        const state = loadState();
        if (!validateCsrfToken(req, state)) {
          return json(res, 403, { error: "Invalid or missing CSRF token" });
        }
      }
      return handler(req, res, param);
    };
  }

  /**
   * Tag a handler so `auth(...)` accepts bearer keys carrying `scope` in
   * addition to the full-scope default. Used as:
   *
   *   auth(requireScope("mint-session")(handler))
   *
   * The inner function is returned unchanged apart from the symbol-keyed
   * `_acceptedScopes` marker — no extra runtime check happens at this
   * layer; `auth` combines authentication and scope validation into one
   * check so composition ordering can't be accidentally inverted.
   */
  function requireScope(scope) {
    return (handler) => {
      handler[ACCEPTED_SCOPES] = [SCOPE_FULL, scope];
      return handler;
    };
  }

  return { auth, csrf, requireScope };
}
