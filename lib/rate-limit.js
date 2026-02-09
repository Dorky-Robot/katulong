/**
 * Simple in-memory rate limiter
 * Tracks request counts per IP address with sliding window
 */

const rateLimitStore = new Map(); // ip -> { count, resetAt }

/**
 * Rate limit middleware
 * @param {number} maxAttempts - Maximum attempts allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {function} Middleware function
 */
export function rateLimit(maxAttempts, windowMs) {
  return (req, res, next) => {
    // Get client IP
    const ip = req.socket.remoteAddress;
    const now = Date.now();

    // Get or create rate limit entry
    let entry = rateLimitStore.get(ip);

    // Reset if window expired
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(ip, entry);
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

/**
 * Cleanup expired rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 60000); // Cleanup every minute
