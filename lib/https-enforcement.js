/**
 * HTTPS Enforcement
 *
 * Handles HTTPS redirection logic for different access methods.
 * Key principles:
 * - Localhost: No HTTPS required (auto-authenticated)
 * - LAN: Requires HTTPS after certificate trust (cert install paths allowed on HTTP)
 * - Internet (ngrok): Requires HTTPS (provided by reverse proxy, but allow public paths on HTTP)
 */

import { getAccessMethod } from './access-method.js';

/**
 * Paths that are explicitly allowed over HTTP for certificate installation.
 * These are needed to bootstrap HTTPS on LAN (chicken-and-egg problem).
 */
export const HTTP_ALLOWED_PATHS = [
  "/connect/trust",
  "/connect/trust/ca.crt",
  "/connect/trust/ca.mobileconfig",
];

/**
 * Determine if HTTPS is required for this request.
 *
 * Returns one of:
 * - null: HTTPS not required (allow request to proceed)
 * - { redirect: string }: Redirect to this URL
 * - { block: string }: Block request with this error message
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @param {string} pathname - Request pathname
 * @param {Function} isPublicPath - Function to check if path is public
 * @returns {null | {redirect: string} | {block: string}} Enforcement action
 */
export function checkHttpsEnforcement(req, pathname, isPublicPath) {
  // Already HTTPS - nothing to enforce
  if (req.socket.encrypted) {
    return null;
  }

  const accessMethod = getAccessMethod(req);

  // Localhost: Always allow HTTP (auto-authenticated)
  if (accessMethod === "localhost") {
    return null;
  }

  // Certificate installation paths: Always allow HTTP (needed to bootstrap HTTPS)
  if (HTTP_ALLOWED_PATHS.includes(pathname)) {
    return null;
  }

  // Public paths (login assets, etc.): Allow HTTP for internet access (ngrok)
  // This allows ngrok to serve the login page over HTTP locally before TLS termination
  if (isPublicPath(pathname)) {
    // LAN: Require HTTPS even for public paths (after cert trust)
    // This prevents accessing login page over HTTP on LAN
    if (accessMethod === "lan") {
      // Exception: Allow /connect/trust page itself to be served over HTTP
      if (pathname.startsWith("/connect/trust")) {
        return null;
      }
      // All other paths on LAN require HTTPS
      return { redirect: `https://${getHost(req)}:${getHttpsPort()}${req.url}` };
    }
    // Internet: Allow public paths over HTTP (ngrok terminates TLS upstream)
    return null;
  }

  // Protected paths: Always require HTTPS (except localhost)
  // Determine redirect target based on access method
  const redirectTarget = getHttpsRedirectTarget(accessMethod, pathname);
  return { redirect: redirectTarget };
}

/**
 * Get the redirect target for HTTPS enforcement.
 *
 * @param {"lan" | "internet"} accessMethod - Access method (not localhost)
 * @param {string} currentPath - Current pathname
 * @returns {string} Redirect URL
 */
function getHttpsRedirectTarget(accessMethod, currentPath) {
  if (accessMethod === "lan") {
    // LAN: Redirect to certificate trust page (need to install cert first)
    // Exception: If already on /connect/trust, allow it through
    if (currentPath === "/connect/trust") {
      return currentPath; // No redirect, allow it through (handled by null check above)
    }
    return "/connect/trust";
  } else {
    // Internet: Redirect to login page (ngrok provides valid TLS)
    return "/login";
  }
}

/**
 * Get the host without port for redirect URLs.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {string} Host without port
 */
function getHost(req) {
  return (req.headers.host || "localhost").replace(/:\d+$/, "");
}

/**
 * Get the HTTPS port from environment or default.
 *
 * @returns {number} HTTPS port
 */
function getHttpsPort() {
  return parseInt(process.env.HTTPS_PORT || "3002", 10);
}

/**
 * Determine where to redirect unauthenticated users based on access method.
 * This is separate from HTTPS enforcement - it's for auth middleware.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {string} Redirect path
 */
export function getUnauthenticatedRedirect(req) {
  const accessMethod = getAccessMethod(req);

  // LAN over HTTP: Redirect to certificate trust page
  if (accessMethod === "lan" && !req.socket.encrypted) {
    return "/connect/trust";
  }

  // All other cases: Redirect to login
  return "/login";
}

/**
 * Check if request needs session validation and HTTPS redirect.
 * For LAN users who have a valid session but are accessing over HTTP,
 * redirect them to HTTPS (they've already installed the cert).
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @param {string} pathname - Request pathname
 * @param {Function} isPublicPath - Function to check if path is public
 * @param {Function} validateSession - Function to validate session
 * @returns {null | {redirect: string}} Redirect action or null
 */
export function checkSessionHttpsRedirect(req, pathname, isPublicPath, validateSession) {
  // Only check if:
  // 1. Not already on HTTPS
  // 2. Not localhost
  // 3. Not a public path
  // 4. Not a cert installation path
  if (req.socket.encrypted) return null;
  if (getAccessMethod(req) === "localhost") return null;
  if (isPublicPath(pathname)) return null;
  if (HTTP_ALLOWED_PATHS.includes(pathname)) return null;

  // Check if user has a valid session (they've installed cert)
  const hasValidSession = validateSession(req);

  if (hasValidSession) {
    // User has cert installed, redirect to HTTPS
    const host = getHost(req);
    const httpsPort = getHttpsPort();
    return { redirect: `https://${host}:${httpsPort}${req.url}` };
  }

  return null;
}
