/**
 * Route middleware factories
 *
 * Wraps route handlers with authentication and CSRF checks. Extracted from
 * lib/routes.js (Tier 3.4). The middleware is a factory because it closes
 * over the server's `isAuthenticated` and `json` helpers.
 */

import { loadState } from "../auth.js";
import { isLocalRequest } from "../access-method.js";
import { validateCsrfToken } from "../http-util.js";

/**
 * @param {object} ctx
 * @param {(req: object) => boolean} ctx.isAuthenticated
 * @param {(res: object, status: number, body: object) => void} ctx.json
 * @returns {{ auth: Function, csrf: Function }}
 */
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

  return { auth, csrf };
}
