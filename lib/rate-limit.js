/**
 * Simple in-memory rate limiter
 * Tracks request counts per IP address with sliding window
 */

const rateLimitStore = new Map(); // key -> { count, resetAt }

/**
 * Rate limit middleware
 * @param {number} maxAttempts - Maximum attempts allowed
 * @param {number} windowMs - Time window in milliseconds
 * @param {function} [keyFn] - Optional function to derive rate-limit key from request. Defaults to req.socket.remoteAddress.
 * @returns {function} Middleware function
 */
export function rateLimit(maxAttempts, windowMs, keyFn) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.socket.remoteAddress;
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
