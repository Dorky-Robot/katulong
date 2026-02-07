import { extname } from "node:path";

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
  // Only trust actual TLS connection state, not headers (which can be spoofed)
  const proto = req.socket?.encrypted ? "https" : "http";
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
