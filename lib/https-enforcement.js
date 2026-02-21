/**
 * HTTPS Enforcement
 *
 * Handles HTTPS redirection logic for different access methods.
 * Key principles:
 * - Localhost: No HTTPS required (auto-authenticated)
 * - Internet (ngrok, Cloudflare Tunnel, etc.): TLS is terminated at the tunnel edge;
 *   public paths allowed over HTTP, protected paths redirect to /login
 */

import { getAccessMethod } from './access-method.js';

/**
 * Paths that are explicitly allowed over HTTP for certificate installation.
 * These are needed to bootstrap HTTPS (cert install paths must be reachable over HTTP).
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
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @param {string} pathname - Request pathname
 * @param {Function} isPublicPath - Function to check if path is public
 * @param {Function} isHttpsConnection - Function to check if connection is HTTPS (including tunnels)
 * @returns {null | {redirect: string}} Enforcement action
 */
export function checkHttpsEnforcement(req, pathname, isPublicPath, isHttpsConnection) {
  // Already HTTPS (including tunnels like ngrok) - nothing to enforce
  if (isHttpsConnection(req)) {
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

  // Public paths (login assets, etc.): Allow HTTP for internet access
  // Tunnel services (ngrok, Cloudflare) terminate TLS at their edge
  if (isPublicPath(pathname)) {
    return null;
  }

  // Protected paths: Redirect to login
  return { redirect: "/login" };
}

/**
 * Determine where to redirect unauthenticated users based on access method.
 * This is separate from HTTPS enforcement - it's for auth middleware.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @returns {string} Redirect path
 */
export function getUnauthenticatedRedirect(req) {
  // All unauthenticated non-localhost requests redirect to login
  return "/login";
}

/**
 * Check if request needs session validation and HTTPS redirect.
 * With tunnel-based access, HTTPS is terminated at the tunnel edge, so
 * no local HTTPS redirect is needed. This function always returns null.
 *
 * @param {import('http').IncomingMessage} req - HTTP request
 * @param {string} pathname - Request pathname
 * @param {Function} isPublicPath - Function to check if path is public
 * @param {Function} validateSession - Function to validate session
 * @returns {null} Always null (no local HTTPS redirect needed)
 */
export function checkSessionHttpsRedirect(req, pathname, isPublicPath, validateSession) {
  // With tunnel-based remote access, HTTPS is handled at the tunnel edge.
  // No local HTTPS redirect is needed.
  return null;
}
