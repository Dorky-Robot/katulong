import { extname } from "node:path";

import { timingSafeEqual } from "node:crypto";

// --- Cookie helpers ---

export function parseCookies(header) {
  const map = new Map();
  if (!header) return map;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return map;
}

export function setSessionCookie(res, token, expiry, { secure = false } = {}) {
  const maxAge = Math.floor((expiry - Date.now()) / 1000);
  const existing = res.getHeader("Set-Cookie") || [];
  const cookies = Array.isArray(existing) ? existing : [existing].filter(Boolean);
  let cookie = `katulong_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  cookies.push(cookie);
  res.setHeader("Set-Cookie", cookies);
}

// --- Auth helpers ---

export function getOriginAndRpID(req) {
  const host = req.headers.host || "localhost";
  const hostname = host.split(":")[0];

  // Determine protocol:
  // 1. Trust actual TLS socket state (most secure)
  // 2. Check CF-Visitor header for Cloudflare Tunnel custom domains
  // 3. For known HTTPS-only tunnel services (ngrok, cloudflare, etc.), use HTTPS
  //    These services always terminate TLS at their edge and forward to localhost via HTTP
  // 4. For Cloudflare Tunnel with custom domains: socket is loopback (from cloudflared)
  //    and CF-Connecting-IP header present (added by Cloudflare edge, not forgeable
  //    since the connection is local)
  const isSocketEncrypted = req.socket?.encrypted;

  // Cloudflare Tunnel adds CF-Visitor header with actual client protocol
  let isCloudflareTunnel = false;
  if (req.headers['cf-visitor']) {
    try {
      const cfVisitor = JSON.parse(req.headers['cf-visitor']);
      isCloudflareTunnel = cfVisitor.scheme === 'https';
    } catch {
      // Invalid CF-Visitor header, ignore
    }
  }

  const isHttpsTunnel = isCloudflareTunnel ||
                         hostname.endsWith('.ngrok.app') ||
                         hostname.endsWith('.ngrok.io') ||
                         hostname.endsWith('.trycloudflare.com') ||
                         hostname.endsWith('.loca.lt');
  const addr = req.socket?.remoteAddress || "";
  const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const isCloudflaredTunnel = isLoopback && !!req.headers["cf-connecting-ip"];

  const proto = (isSocketEncrypted || isHttpsTunnel || isCloudflaredTunnel) ? "https" : "http";
  const origin = `${proto}://${host}`;
  return { origin, rpID: hostname };
}

// --- Public path check ---

const STATIC_EXTS = new Set([".js", ".css", ".png", ".ico", ".webp", ".svg", ".woff2", ".json"]);

const PUBLIC_AUTH_ROUTES = new Set([
  "/auth/status",
  "/auth/register/options",
  "/auth/register/verify",
  "/auth/login/options",
  "/auth/login/verify",
  "/auth/logout",
  "/auth/pair/verify",
]);

export function isPublicPath(pathname) {
  if (pathname === "/login" || pathname === "/login.html") return true;
  if (pathname === "/pair" || pathname === "/pair.html") return true;
  if (pathname.startsWith("/connect/trust")) return true;
  if (PUBLIC_AUTH_ROUTES.has(pathname)) return true;

  // Allow static assets only if they look safe (no path traversal, no hidden files)
  const ext = extname(pathname);
  if (ext && STATIC_EXTS.has(ext) && pathname !== "/") {
    // Reject paths with: .. (traversal), leading dot (hidden files), double slashes
    if (pathname.includes("..") || pathname.includes("//") || pathname.startsWith("/.")) {
      return false;
    }
    return true;
  }

  return false;
}

// --- HTML helpers ---

export function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Name sanitization ---

export function sanitizeName(raw) {
  if (!raw || typeof raw !== "string") return null;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return safe || null;
}

// --- CSRF protection ---

/**
 * Get CSRF token for a session
 * @param {AuthState|object} state - Auth state
 * @param {string} sessionToken - Session token
 * @returns {string|null} CSRF token or null if not found
 */
export function getCsrfToken(state, sessionToken) {
  if (!state || !sessionToken) return null;
  const session = state.sessions?.[sessionToken];
  if (!session) return null;
  // Return csrfToken if it exists, null otherwise (backward compatibility)
  return session.csrfToken || null;
}

/**
 * Validate CSRF token for a request
 * @param {object} req - HTTP request
 * @param {AuthState|object} state - Auth state
 * @returns {boolean} True if CSRF token is valid
 */
export function validateCsrfToken(req, state) {
  // Get session token from cookie
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.get("katulong_session");
  if (!sessionToken) return false;

  // Get expected CSRF token from session
  const expectedToken = getCsrfToken(state, sessionToken);
  if (!expectedToken) return false; // No CSRF token in session (old session or error)

  // Get provided CSRF token from header or body
  const providedToken = req.headers["x-csrf-token"];
  if (!providedToken) return false;

  // Constant-time comparison to prevent timing attacks
  if (providedToken.length !== expectedToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(providedToken), Buffer.from(expectedToken));
  } catch {
    return false;
  }
}

// --- Content Security Policy ---

/**
 * Get Content Security Policy header value
 *
 * Strict CSP to mitigate XSS attacks:
 * - default-src 'self': Only load resources from same origin
 * - script-src 'self': Only execute scripts from same origin
 * - style-src 'self' 'unsafe-inline': Allow same-origin and inline styles (for xterm.js)
 * - connect-src 'self' ws: wss:: Allow same-origin and WebSocket connections
 * - img-src 'self' data:: Allow same-origin and data URIs (for images)
 * - font-src 'self': Only load fonts from same origin
 * - object-src 'none': Block Flash, Java, etc.
 * - base-uri 'self': Restrict <base> tag
 * - form-action 'self': Forms can only submit to same origin
 *
 * When accessed through Cloudflare, automatically allows static.cloudflareinsights.com
 * for Cloudflare's analytics script that gets injected automatically.
 *
 * @param {boolean} reportOnly - If true, use report-only mode (default: false)
 * @param {import('http').IncomingMessage} req - HTTP request (optional, for Cloudflare detection)
 * @returns {object} Headers object with CSP header
 */
export function getCspHeaders(reportOnly = false, req = null) {
  // Detect if request is coming through Cloudflare
  const isCloudflare = req && (
    req.headers['cf-ray'] ||
    req.headers['cf-visitor'] ||
    req.headers['cf-connecting-ip']
  );

  // Base script-src policy
  let scriptSrc = "'self'";

  // Allow Cloudflare Insights when proxied through Cloudflare
  if (isCloudflare) {
    scriptSrc += " https://static.cloudflareinsights.com";
  }

  const policy = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'", // unsafe-inline needed for xterm.js inline styles
    "connect-src 'self' ws: wss:",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const headerName = reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  return { [headerName]: policy };
}

// --- Challenge store factory ---

export function createChallengeStore(ttlMs) {
  const challenges = new Map();

  function sweep() {
    const now = Date.now();
    for (const [c, exp] of challenges) {
      if (typeof exp === "number" && now >= exp) challenges.delete(c);
    }
  }

  // Periodic sweep so stale challenges don't accumulate unbounded
  const sweepInterval = setInterval(sweep, ttlMs);
  sweepInterval.unref();

  function store(challenge) {
    challenges.set(challenge, Date.now() + ttlMs);
  }

  function consume(challenge) {
    const expiry = challenges.get(challenge);
    if (!expiry) return false;
    challenges.delete(challenge);
    sweep();
    return Date.now() < expiry;
  }

  return { store, consume, _challenges: challenges, _sweep: sweep };
}
