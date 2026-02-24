/**
 * Route middleware factories.
 *
 * `auth(handler)` rejects unauthenticated requests with 401.
 * `csrf(handler)` validates CSRF tokens for non-localhost requests.
 *
 * Compose: `auth(csrf(handler))` for endpoints that need both.
 */

import { loadState } from "../auth.js";
import { validateCsrfToken } from "../http-util.js";
import { isLocalRequest } from "../access-method.js";

export function createMiddleware(ctx) {
  const { isAuthenticated, json } = ctx;

  function auth(handler) {
    return async (req, res, param) => {
      if (!isAuthenticated(req)) {
        return json(res, 401, { error: "Authentication required" });
      }
      return handler(req, res, param);
    };
  }

  function csrf(handler) {
    return async (req, res, param) => {
      if (!isLocalRequest(req)) {
        const state = loadState();
        if (!validateCsrfToken(req, state)) {
          return json(res, 403, { error: "Invalid or missing CSRF token" });
        }
      }
      return handler(req, res, param);
    };
  }

  return { auth, csrf };
}
