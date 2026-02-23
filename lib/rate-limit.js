/**
 * Simple in-memory rate limiter
 * Tracks request counts per IP address with sliding window
 */

const rateLimitStore = new Map(); // key -> { count, resetAt }

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
  if (addr === "::1" || addr === "127.0.0.1" || addr === "::ffff:127.0.0.1") return true;

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
 * Rate limit middleware
 * @param {number} maxAttempts - Maximum attempts allowed
 * @param {number} windowMs - Time window in milliseconds
 * @param {function} [keyFn] - Optional function to derive rate-limit key from request. Defaults to getClientIp(req).
 * @returns {function} Middleware function
 */
export function rateLimit(maxAttempts, windowMs, keyFn) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : getClientIp(req);
    const now = Date.now();

    // Sweep expired entries inline (lazy cleanup — no leaked setInterval)
    for (const [k, e] of rateLimitStore) {
      if (now > e.resetAt) rateLimitStore.delete(k);
    }

    // Get or create rate limit entry
    let entry = rateLimitStore.get(key);

    // Reset if window expired
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }

    // Increment count
    entry.count++;

    // Check if limit exceeded
    if (entry.count > maxAttempts) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": retryAfter.toString()
      });
      res.end(JSON.stringify({
        error: "Too many requests",
        retryAfter
      }));
      return;
    }

    next();
  };
}
