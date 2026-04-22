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
 * returns a new wrapper function carrying an ACCEPTED_SCOPES tag; `auth`
 * reads that tag to know which scopes to accept. requireScope does NOT mutate
 * the passed handler — each call returns a fresh function so a handler reused
 * across multiple routes cannot have its scope tag silently overwritten.
 * Ordering is fixed: requireScope must be nested inside auth.
 *
 * Bearer-only routes: some endpoints (e.g. `/api/sessions/mint`) must reject
 * cookie and localhost auth even when scope checks pass. Wrap those with
 * `requireBearerAuth(...)` — `auth` refuses anything that isn't a Bearer
 * API key before the scope check.
 */

import { loadState } from "../auth.js";
import { isLocalRequest } from "../access-method.js";
import { validateCsrfToken } from "../http-util.js";
import { SCOPE_FULL } from "../api-key-scopes.js";

const ACCEPTED_SCOPES = Symbol("ACCEPTED_SCOPES");
const BEARER_ONLY = Symbol("BEARER_ONLY");

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
 * @returns {{ auth: Function, csrf: Function, requireScope: Function, requireBearerAuth: Function }}
 */
export function createMiddleware(ctx) {
  const { isAuthenticated, json } = ctx;

  function auth(handler) {
    const accepted = handler[ACCEPTED_SCOPES] || [SCOPE_FULL];
    const bearerOnly = handler[BEARER_ONLY] === true;
    return async (req, res, param) => {
      if (!isAuthenticated(req)) {
        return json(res, 401, { error: "Authentication required" });
      }
      if (bearerOnly && !req._apiKeyAuth) {
        return json(res, 403, { error: "Bearer API key required" });
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
   * Wrap a handler so `auth(...)` accepts Bearer keys carrying `scope` in
   * addition to the full-scope default. Used as:
   *
   *   auth(requireScope("mint-session")(handler))
   *
   * Returns a fresh wrapper function — the passed handler is not mutated.
   * Reusing a handler reference across multiple requireScope calls is safe;
   * each call produces an independent wrapper with its own scope tag.
   */
  function requireScope(scope) {
    return (handler) => {
      const wrapped = (req, res, param) => handler(req, res, param);
      Object.defineProperty(wrapped, ACCEPTED_SCOPES, {
        value: [SCOPE_FULL, scope],
        enumerable: false,
        writable: false,
        configurable: false,
      });
      const existing = handler[BEARER_ONLY];
      if (existing === true) {
        Object.defineProperty(wrapped, BEARER_ONLY, {
          value: true, enumerable: false, writable: false, configurable: false,
        });
      }
      return wrapped;
    };
  }

  /**
   * Wrap a handler so `auth(...)` refuses cookie and localhost requests,
   * accepting only Bearer API key authentication. Used as:
   *
   *   auth(requireBearerAuth(requireScope("mint-session")(handler)))
   *
   * Returns a fresh wrapper — passed handler is not mutated. Composition with
   * requireScope is order-independent because both markers are read by auth.
   */
  function requireBearerAuth(handler) {
    const wrapped = (req, res, param) => handler(req, res, param);
    Object.defineProperty(wrapped, BEARER_ONLY, {
      value: true, enumerable: false, writable: false, configurable: false,
    });
    const existing = handler[ACCEPTED_SCOPES];
    if (Array.isArray(existing)) {
      Object.defineProperty(wrapped, ACCEPTED_SCOPES, {
        value: existing, enumerable: false, writable: false, configurable: false,
      });
    }
    return wrapped;
  }

  return { auth, csrf, requireScope, requireBearerAuth };
}
