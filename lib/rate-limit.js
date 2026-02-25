/**
 * Simple in-memory rate limiter
 * Tracks request counts per IP address with sliding window
 */

import { isLoopbackAddress } from "./access-method.js";

/**
 * Check if a socket address indicates a proxied connection (loopback or private IP).
 * When the socket comes from a loopback or private IP, there is likely a reverse proxy
 * (e.g., ngrok, Cloudflare Tunnel) in front, and we can trust X-Forwarded-For.
 * @param {string} addr - Socket remote address
 * @returns {boolean}
 */
function isProxiedSocket(addr) {
  if (!addr) return false;

  // Loopback
  if (isLoopbackAddress(addr)) return true;

  // Strip IPv4-mapped IPv6 prefix for RFC1918 checks
  const ipv4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const parts = ipv4.split(".");
  if (parts.length !== 4) return false;

  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);

  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 127) return true;                        // 127.0.0.0/8

  return false;
}

// Matches a bare IPv4 address (e.g. "1.2.3.4") or an IPv6 address
// (e.g. "::1", "2001:db8::1", "::ffff:1.2.3.4").  Used to validate the
// extracted X-Forwarded-For value so attackers behind a proxy cannot inject
// arbitrary strings as rate-limit keys.
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isValidIp(ip) {
  return IPV4_RE.test(ip) || IPV6_RE.test(ip);
}

/**
 * Extract the real client IP address.
 * Trusts X-Forwarded-For only when the socket comes from a loopback or private
 * address, indicating a reverse proxy (ngrok, Cloudflare Tunnel, etc.) is in front.
 * Direct connections always use the socket address to prevent header spoofing.
 * The extracted XFF value is validated as an IP address to prevent attackers
 * behind a proxy from injecting arbitrary strings as rate-limit keys.
 * @param {import('http').IncomingMessage} req
 * @returns {string} Client IP address
 */
export function getClientIp(req) {
  const socketAddr = req.socket?.remoteAddress || "";

  if (isProxiedSocket(socketAddr)) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const firstIp = xff.split(",")[0].trim();
      if (firstIp && isValidIp(firstIp)) return firstIp;
    }
  }

  return socketAddr;
}

/**
 * Prune all expired entries from a rate-limit store.
 * @param {Map} store - The rate-limit store to prune
 */
function pruneExpired(store) {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now > e.resetAt) store.delete(k);
  }
}

/**
 * Create a rate limiter instance with isolated state.
 *
 * Each instance gets its own Map so state never leaks between instances
 * (e.g. between tests or independent server instances).
 *
 * @param {object} [options]
 * @param {number} [options.cleanupMs=60000] - How often to run background cleanup (ms).
 *   Pass 0 to disable the background interval (cleanup still runs lazily on each check).
 * @returns {{ rateLimit: function, destroy: function }}
 */
export function createRateLimiter({ cleanupMs = 60000 } = {}) {
  const store = new Map(); // key -> { count, resetAt }

  // Optional background cleanup to bound memory use when traffic is low.
  // The interval is unref()d so it never prevents the process from exiting.
  let cleanupInterval = null;
  if (cleanupMs > 0) {
    cleanupInterval = setInterval(() => pruneExpired(store), cleanupMs);
    cleanupInterval.unref();
  }

  /**
   * Rate limit middleware factory.
   * @param {number} maxAttempts - Maximum attempts allowed
   * @param {number} windowMs - Time window in milliseconds
   * @param {function} [keyFn] - Optional function to derive rate-limit key from request
   * @returns {function} Middleware function with a .check(req) method
   */
  function rateLimit(maxAttempts, windowMs, keyFn) {
    function checkLimit(req) {
      const key = keyFn ? keyFn(req) : getClientIp(req);
      const now = Date.now();

      pruneExpired(store);

      let entry = store.get(key);

      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        store.set(key, entry);
      }

      entry.count++;

      if (entry.count > maxAttempts) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        return { exceeded: true, retryAfter };
      }

      return { exceeded: false, retryAfter: 0 };
    }

    function middleware(req, res, next) {
      const result = checkLimit(req);
      if (result.exceeded) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": result.retryAfter.toString()
        });
        res.end(JSON.stringify({
          error: "Too many requests",
          retryAfter: result.retryAfter
        }));
        return;
      }
      next();
    }

    middleware.check = checkLimit;
    return middleware;
  }

  /**
   * Reset the rate limit for a specific key.
   * @param {string} key
   */
  function reset(key) {
    store.delete(key);
  }

  /**
   * Stop the background cleanup interval and clear all stored state.
   * Call this in test teardown or server shutdown to avoid leaked timers.
   */
  function destroy() {
    if (cleanupInterval !== null) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    store.clear();
  }

  return { rateLimit, reset, destroy };
}

// --- Backward-compatible default instance ---
//
// Existing callers that do:
//   import { rateLimit } from './rate-limit.js'
// continue to work unchanged.  The default instance uses lazy inline cleanup
// only (cleanupMs: 0) so it never creates a background interval of its own —
// the same behaviour as the previous module-level Map implementation.
const _defaultInstance = createRateLimiter({ cleanupMs: 0 });

/**
 * Rate limit middleware (backward-compatible default instance).
 * @param {number} maxAttempts - Maximum attempts allowed
 * @param {number} windowMs - Time window in milliseconds
 * @param {function} [keyFn] - Optional function to derive rate-limit key from request
 * @returns {function} Middleware function
 */
export const rateLimit = _defaultInstance.rateLimit;
