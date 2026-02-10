import "dotenv/config";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { readFileSync, realpathSync, existsSync, watch, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { encode, decoder } from "./lib/ndjson.js";
import { log } from "./lib/log.js";
import { createServerPeer, destroyPeer } from "./lib/p2p.js";
import { detectImage, readRawBody, MAX_UPLOAD_BYTES } from "./lib/upload.js";
import {
  loadState, saveState, isSetup,
  generateRegistrationOpts, generateRegistrationOptsForUser, verifyRegistration,
  generateAuthOpts, verifyAuth,
  createSession, validateSession, pruneExpiredSessions, revokeAllSessions,
  withStateLock, refreshSessionActivity,
} from "./lib/auth.js";
import {
  parseCookies, setSessionCookie, getOriginAndRpID,
  isPublicPath, createChallengeStore, escapeAttr,
  getCsrfToken, validateCsrfToken, getCspHeaders,
} from "./lib/http-util.js";
import { rateLimit } from "./lib/rate-limit.js";
import {
  processRegistration,
  processAuthentication,
  processPairing,
  extractChallenge,
} from "./lib/auth-handlers.js";
import { SessionName } from "./lib/session-name.js";
import { PairingChallengeStore } from "./lib/pairing-challenge.js";
import { AuthState } from "./lib/auth-state.js";
import { ensureCerts, generateMobileConfig } from "./lib/tls.js";
import { ensureHostKey, startSSHServer } from "./lib/ssh.js";
import { validateMessage } from "./lib/websocket-validation.js";
import { CredentialLockout } from "./lib/credential-lockout.js";
import mdns from "multicast-dns";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "3002", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const DATA_DIR = process.env.KATULONG_DATA_DIR || __dirname;
const SSH_PORT = parseInt(process.env.SSH_PORT || "2222", 10);

// --- TLS certificates (auto-generated) ---

const tlsPaths = ensureCerts(DATA_DIR, "Katulong");
log.info("TLS certificates ready", { dir: join(DATA_DIR, "tls") });

const sshHostKey = ensureHostKey(DATA_DIR);

// --- Authentication tokens ---
// Generate separate tokens for setup (WebAuthn registration) and SSH access
const SETUP_TOKEN = process.env.SETUP_TOKEN || randomBytes(16).toString("hex");
const SSH_PASSWORD = process.env.SSH_PASSWORD || randomBytes(16).toString("hex");
const RP_NAME = "Katulong";

// --- Rate limiting ---
// 10 attempts per minute for auth endpoints
const authRateLimit = rateLimit(10, 60000);
// Stricter limit for pairing (10 attempts per 30 seconds)
const pairingRateLimit = rateLimit(10, 30000);

if (!process.env.SETUP_TOKEN) {
  log.info("Setup token generated", { token: SETUP_TOKEN });
}
if (!process.env.SSH_PASSWORD) {
  log.info("SSH password generated", { password: SSH_PASSWORD });
}

if (process.env.KATULONG_NO_AUTH === "1") {
  log.warn("WARNING: KATULONG_NO_AUTH=1 — authentication is DISABLED. All requests are treated as authenticated. Do NOT use this in production or on untrusted networks.");
}

// --- Constants ---

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB limit for request bodies
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIR_TTL_MS = 30 * 1000; // 30 seconds
const DAEMON_RECONNECT_INITIAL_MS = 1000; // 1 second
const DAEMON_RECONNECT_MAX_MS = 30000; // 30 seconds

// --- Challenge storage (in-memory, 5-min expiry) ---

const { store: storeChallenge, consume: consumeChallenge, _challenges: challenges } = createChallengeStore(CHALLENGE_TTL_MS);

// --- Device pairing (in-memory, 30s expiry) ---

const pairingStore = new PairingChallengeStore(PAIR_TTL_MS);

// --- Credential lockout (in-memory, 15 min window) ---

const credentialLockout = new CredentialLockout({
  maxAttempts: 5,        // 5 failures
  windowMs: 15 * 60 * 1000,  // within 15 minutes
  lockoutMs: 15 * 60 * 1000, // locks for 15 minutes
});

function getLanIP() {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === "IPv4") return iface.address;
    }
  }
  return null;
}

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || "";

  // Check socket address
  const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  if (!isLoopback) return false;

  // CRITICAL SECURITY: Even if socket is loopback, check Host/Origin headers
  // to detect reverse proxies (ngrok, Cloudflare Tunnel, etc.)
  // If Host/Origin indicates external domain, this is PROXIED traffic = NOT local
  const host = (req.headers.host || "").toLowerCase();
  const origin = (req.headers.origin || "").toLowerCase();

  // Check if Host header indicates localhost
  const hostIsLocal = host.startsWith("localhost:") ||
                      host === "localhost" ||
                      host.startsWith("127.0.0.1:") ||
                      host === "127.0.0.1" ||
                      host.startsWith("[::1]:") ||
                      host === "[::1]";

  // Check if Origin header indicates localhost (if present)
  const originIsLocal = !origin ||
                        origin.includes("://localhost") ||
                        origin.includes("://127.0.0.1") ||
                        origin.includes("://[::1]");

  // Only treat as local if BOTH socket AND headers indicate localhost
  return hostIsLocal && originIsLocal;
}

function isAuthenticated(req) {
  if (process.env.KATULONG_NO_AUTH === "1") {
    log.debug("Auth bypassed: KATULONG_NO_AUTH=1");
    return true;
  }
  if (isLocalRequest(req)) {
    log.debug("Auth bypassed: localhost", { ip: req.socket.remoteAddress });
    return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.get("katulong_session");
  if (!token) {
    log.debug("Auth rejected: no token", { ip: req.socket.remoteAddress });
    return false;
  }
  const state = loadState();
  const valid = validateSession(state, token);
  log.debug("Auth check", {
    ip: req.socket.remoteAddress,
    hasState: state !== null,
    tokenPrefix: token.substring(0, 8) + "...",
    valid
  });
  return valid;
}

// Paths that are explicitly allowed over HTTP (for certificate installation)
// Everything else MUST use HTTPS (or localhost)
const HTTP_ALLOWED_PATHS = [
  "/connect/trust",
  "/connect/trust/ca.crt",
  "/connect/trust/ca.mobileconfig",
];

// --- IPC client to daemon ---

let daemonSocket = null;
let daemonConnected = false;
let daemonReconnectDelay = DAEMON_RECONNECT_INITIAL_MS;
const pendingRPC = new Map();

function connectDaemon() {
  if (daemonSocket) {
    daemonSocket.removeAllListeners();
    daemonSocket.destroy();
  }

  daemonSocket = createConnection(SOCKET_PATH);

  daemonSocket.on("connect", () => {
    daemonConnected = true;
    daemonReconnectDelay = DAEMON_RECONNECT_INITIAL_MS;
    log.info("Connected to daemon");
  });

  daemonSocket.on("data", decoder((msg) => {
    if (msg.id && pendingRPC.has(msg.id)) {
      const { resolve, timer } = pendingRPC.get(msg.id);
      clearTimeout(timer);
      pendingRPC.delete(msg.id);
      resolve(msg);
    } else {
      relayBroadcast(msg);
    }
  }));

  daemonSocket.on("close", () => {
    daemonConnected = false;
    log.warn("Disconnected from daemon", { reconnectMs: daemonReconnectDelay });
    for (const [, { reject, timer }] of pendingRPC) {
      clearTimeout(timer);
      reject(new Error("Daemon disconnected"));
    }
    pendingRPC.clear();
    setTimeout(connectDaemon, daemonReconnectDelay);
    daemonReconnectDelay = Math.min(daemonReconnectDelay * 2, DAEMON_RECONNECT_MAX_MS);
  });

  daemonSocket.on("error", (err) => {
    if (err.code !== "ENOENT" && err.code !== "ECONNREFUSED") {
      log.error("Daemon socket error", { error: err.message });
    }
  });
}

function daemonRPC(msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!daemonConnected) return reject(new Error("Daemon not connected"));
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRPC.delete(id);
      reject(new Error("RPC timeout"));
    }, timeoutMs);
    pendingRPC.set(id, { resolve, reject, timer });
    daemonSocket.write(encode({ id, ...msg }));
  });
}

function daemonSend(msg) {
  if (daemonConnected) daemonSocket.write(encode(msg));
}

connectDaemon();

// --- Helpers ---

function readBody(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function parseJSON(req, maxSize = MAX_REQUEST_BODY_SIZE) {
  const body = await readBody(req, maxSize);
  return JSON.parse(body);
}

// --- HTTP routes ---

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
  ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

function isLanHost(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host);
}

const routes = [
  { method: "GET", path: "/", handler: (req, res) => {
    let html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");

    // Inject CSRF token if authenticated
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies.get("katulong_session");
    if (sessionToken) {
      const state = loadState();
      const csrfToken = getCsrfToken(state, sessionToken);
      if (csrfToken) {
        // Inject CSRF token as a meta tag
        html = html.replace("<head>", `<head>\n    <meta name="csrf-token" content="${escapeAttr(csrfToken)}">`);
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/html",
      ...getCspHeaders()
    });
    res.end(html);
  }},

  { method: "GET", path: "/manifest.json", handler: (req, res) => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "public", "manifest.json"), "utf-8"));
    if (isLanHost(req)) {
      manifest.name = "Katulong (LAN)";
      manifest.short_name = "Katulong LAN";
    }
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(JSON.stringify(manifest));
  }},

  { method: "GET", path: "/login", handler: (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html",
      ...getCspHeaders()
    });
    res.end(readFileSync(join(__dirname, "public", "login.html"), "utf-8"));
  }},

  // --- Auth routes ---

  { method: "GET", path: "/auth/status", handler: (req, res) => {
    // Allow CORS for certificate trust check (HTTP → HTTPS cross-origin fetch)
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    json(res, 200, { setup: isSetup() });
  }},

  { method: "POST", path: "/auth/register/options", handler: async (req, res) => {
    const { setupToken } = await parseJSON(req);
    if (setupToken !== SETUP_TOKEN) {
      return json(res, 403, { error: "Invalid setup token" });
    }
    const { origin, rpID } = getOriginAndRpID(req);
    let opts, userID;
    if (isSetup()) {
      const state = loadState();
      ({ opts, userID } = await generateRegistrationOptsForUser(state.user.id, RP_NAME, rpID, origin));
    } else {
      ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, origin));
    }
    storeChallenge(opts.challenge);
    // Store userID temporarily with the challenge for use during verification
    challenges.set(`userID:${opts.challenge}`, userID);
    json(res, 200, opts);
  }},

  { method: "POST", path: "/auth/register/verify", handler: async (req, res) => {
    // I/O: Parse request
    const { credential, setupToken, deviceId, deviceName, userAgent: clientUserAgent } = await parseJSON(req);
    const { origin, rpID } = getOriginAndRpID(req);

    // I/O: Extract and consume challenge
    const challenge = extractChallenge(credential);
    const challengeValid = consumeChallenge(challenge);

    // I/O: Retrieve userID
    const userID = challenges.get(`userID:${challenge}`);
    challenges.delete(`userID:${challenge}`);

    // Extract user-agent (prefer client-provided, fallback to header)
    const userAgent = clientUserAgent || req.headers['user-agent'] || 'Unknown';

    // Functional core: Process registration logic
    const result = await processRegistration({
      credential,
      setupToken,
      expectedSetupToken: SETUP_TOKEN,
      challenge,
      challengeValid,
      userID,
      origin,
      rpID,
      currentState: loadState(),
      deviceId,
      deviceName,
      userAgent,
    });

    // I/O: Handle result
    if (!result.success) {
      return json(res, result.statusCode, { error: result.message });
    }

    // I/O: Persist state and set cookie
    const { session, updatedState } = result.data;
    await withStateLock(async () => updatedState);
    setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });
    json(res, 200, { ok: true });
  }},

  { method: "POST", path: "/auth/login/options", handler: async (req, res) => {
    const state = loadState();
    if (!state) {
      return json(res, 400, { error: "Not set up yet" });
    }
    const { rpID } = getOriginAndRpID(req);
    const opts = await generateAuthOpts(state.credentials, rpID);
    storeChallenge(opts.challenge);
    json(res, 200, opts);
  }},

  { method: "POST", path: "/auth/login/verify", handler: async (req, res) => {
    // I/O: Parse request
    const { credential } = await parseJSON(req);
    const { origin, rpID } = getOriginAndRpID(req);

    // Check if credential is locked out
    const lockoutStatus = credentialLockout.isLocked(credential.id);
    if (lockoutStatus.locked) {
      return json(res, 403, {
        error: `Too many failed attempts. Try again in ${lockoutStatus.retryAfter} seconds.`,
        retryAfter: lockoutStatus.retryAfter,
      });
    }

    // I/O: Extract and consume challenge
    const challenge = extractChallenge(credential);
    const challengeValid = consumeChallenge(challenge);

    // Functional core: Process authentication logic
    const result = await processAuthentication({
      credential,
      challenge,
      challengeValid,
      origin,
      rpID,
      currentState: loadState(),
    });

    // I/O: Handle result
    if (!result.success) {
      // Record failed attempt
      const lockout = credentialLockout.recordFailure(credential.id);
      if (lockout.locked) {
        return json(res, 403, {
          error: `Too many failed attempts. Account locked for ${lockout.retryAfter} seconds.`,
          retryAfter: lockout.retryAfter,
        });
      }
      return json(res, result.statusCode, { error: result.message });
    }

    // Success: reset lockout counter
    credentialLockout.recordSuccess(credential.id);

    // I/O: Persist state and set cookie
    const { session, updatedState } = result.data;
    await withStateLock(async () => updatedState);
    setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });
    json(res, 200, { ok: true });
  }},

  // --- Pairing routes ---

  { method: "POST", path: "/auth/pair/start", handler: (req, res) => {
    // Only authenticated users (e.g. localhost auto-auth) can start pairing
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const state = loadState();
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    const challenge = pairingStore.create();
    const lanIP = getLanIP();
    const url = lanIP ? `https://${lanIP}:${HTTPS_PORT}/pair?code=${challenge.code}` : null;
    json(res, 200, { ...challenge.toJSON(), url });
  }},

  { method: "POST", path: "/auth/pair/verify", handler: async (req, res) => {
    // I/O: Parse request and consume pairing challenge
    const { code, pin, deviceId, deviceName, userAgent: clientUserAgent } = await parseJSON(req);
    const pairingResult = pairingStore.consume(code, pin);

    // Handle rate limiting (exponential backoff)
    if (pairingResult.reason === "rate-limited" && pairingResult.retryAfter) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(pairingResult.retryAfter),
      });
      res.end(JSON.stringify({
        error: "Too many failed attempts. Please wait before trying again.",
        retryAfter: pairingResult.retryAfter,
      }));
      return;
    }

    // Extract user-agent (prefer client-provided, fallback to header)
    const userAgent = clientUserAgent || req.headers['user-agent'] || 'Unknown';

    // Functional core: Process pairing logic
    const result = processPairing({
      pairingResult,
      currentState: loadState(),
      deviceId,
      deviceName,
      userAgent,
    });

    // I/O: Handle result
    if (!result.success) {
      log.warn("Pair verify failed", { reason: result.reason, code, storeSize: pairingStore.size() });
      return json(res, result.statusCode, { error: result.message });
    }

    // I/O: Persist state and set cookie
    const { session, updatedState } = result.data;
    await withStateLock(async () => updatedState);
    setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });

    // I/O: Notify WebSocket clients
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "pair-complete", code }));
      }
    }

    json(res, 200, { ok: true });
  }},

  { method: "GET", prefix: "/auth/pair/status/", handler: (req, res, code) => {
    // Only authenticated users can check pairing status
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const consumed = pairingStore.wasConsumed(code);
    json(res, 200, { consumed });
  }},

  { method: "GET", path: "/pair", handler: (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html",
      ...getCspHeaders()
    });
    res.end(readFileSync(join(__dirname, "public", "pair.html"), "utf-8"));
  }},

  // --- Trust / certificate routes ---

  { method: "GET", path: "/connect/trust", handler: (req, res) => {
    const lanIP = getLanIP();
    const targetUrl = lanIP ? `https://katulong.local` : `https://localhost:${HTTPS_PORT}`;
    let html = readFileSync(join(__dirname, "public", "trust.html"), "utf-8");
    html = html.replace("<body>", `<body data-https-url="${escapeAttr(targetUrl)}" data-lan-ip="${escapeAttr(lanIP || "")}" data-https-port="${escapeAttr(HTTPS_PORT)}">`);

    res.writeHead(200, {
      "Content-Type": "text/html",
      ...getCspHeaders()
    });
    res.end(html);
  }},

  { method: "GET", path: "/connect/trust/ca.crt", handler: (req, res) => {
    const cert = readFileSync(tlsPaths.caCert);
    res.writeHead(200, {
      "Content-Type": "application/x-x509-ca-cert",
      "Content-Disposition": "attachment; filename=katulong-ca.crt",
    });
    res.end(cert);
  }},

  { method: "GET", path: "/connect/trust/ca.mobileconfig", handler: (req, res) => {
    const caCertPem = readFileSync(tlsPaths.caCert, "utf-8");
    const mobileconfig = generateMobileConfig(caCertPem, "Katulong");
    res.writeHead(200, {
      "Content-Type": "application/x-apple-aspen-config",
      "Content-Disposition": "attachment; filename=katulong.mobileconfig",
    });
    res.end(mobileconfig);
  }},

  { method: "GET", path: "/connect/info", handler: (req, res) => {
    const lanIP = getLanIP();
    const trustUrl = lanIP ? `http://${lanIP}:${PORT}/connect/trust` : `/connect/trust`;
    json(res, 200, { trustUrl, httpsPort: HTTPS_PORT, sshPort: SSH_PORT, sshHost: lanIP || "localhost" });
  }},

  { method: "GET", path: "/connect", handler: (req, res) => {
    const lanIP = getLanIP();
    const trustUrl = lanIP ? `http://${lanIP}:${PORT}/connect/trust` : `/connect/trust`;
    let html = readFileSync(join(__dirname, "public", "connect.html"), "utf-8");
    html = html.replace("<body>", `<body data-trust-url="${escapeAttr(trustUrl)}" data-https-port="${escapeAttr(HTTPS_PORT)}">`);
    res.writeHead(200, {
      "Content-Type": "text/html",
      ...getCspHeaders()
    });
    res.end(html);
  }},

  { method: "POST", path: "/auth/logout", handler: async (req, res) => {
    const state = loadState();
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get("katulong_session");
    if (token) {
      // Use withStateLock for atomic state modification
      await withStateLock(async (state) => {
        if (state && state.isValidSession(token)) {
          return state.removeSession(token);
        }
        return state;
      });
    }
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
  }},

  { method: "POST", path: "/auth/revoke-all", handler: (req, res) => {
    const state = loadState();
    if (!state) return json(res, 400, { error: "Not set up" });
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    revokeAllSessions(state);
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
  }},

  // --- Device management ---

  { method: "GET", path: "/auth/devices", handler: (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const state = loadState();
    if (!state) return json(res, 400, { error: "Not set up" });
    const devices = state.getCredentialsWithMetadata();
    json(res, 200, { devices });
  }},

  { method: "POST", prefix: "/auth/devices/", handler: async (req, res, param) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    // param is everything after /auth/devices/
    // e.g., "abc123/name" or "abc123/refresh"
    const parts = param.split('/');
    const id = parts[0];
    const action = parts[1];

    if (action === 'name') {
      // POST /auth/devices/:id/name
      const { name } = await parseJSON(req);
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return json(res, 400, { error: "Device name is required" });
      }

      try {
        await withStateLock(async (state) => {
          if (!state) throw new Error("Not set up");
          const credential = state.getCredential(id);
          if (!credential) throw new Error("Device not found");
          return state.updateCredential(id, { name: name.trim() });
        });
        json(res, 200, { ok: true });
      } catch (err) {
        if (err.message === 'Device not found') {
          return json(res, 404, { error: err.message });
        }
        throw err;
      }
    } else if (action === 'refresh') {
      // POST /auth/devices/:id/refresh
      try {
        await withStateLock(async (state) => {
          if (!state) throw new Error("Not set up");
          const credential = state.getCredential(id);
          if (!credential) throw new Error("Device not found");
          return state.updateCredential(id, { lastUsedAt: Date.now() });
        });
        json(res, 200, { ok: true });
      } catch (err) {
        if (err.message === 'Device not found') {
          return json(res, 404, { error: err.message });
        }
        throw err;
      }
    } else {
      json(res, 404, { error: "Not found" });
    }
  }},

  { method: "DELETE", prefix: "/auth/devices/", handler: async (req, res, id) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const state = loadState();
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    // Prevent removing devices from localhost (the server machine)
    // This prevents accidentally breaking the server
    if (isLocalRequest(req)) {
      return json(res, 403, {
        error: "Cannot remove devices from the server machine (would break Katulong). Remove from a remote device instead."
      });
    }

    try {
      await withStateLock(async (state) => {
        if (!state) throw new Error("Not set up");
        const credential = state.getCredential(id);
        if (!credential) throw new Error("Device not found");
        return state.removeCredential(id);
      });
      json(res, 200, { ok: true });
    } catch (err) {
      if (err.message === 'Cannot remove the last credential - would lock you out') {
        return json(res, 400, { error: "Cannot remove the last device. At least one device must remain." });
      }
      if (err.message === 'Device not found') {
        return json(res, 404, { error: "Device not found" });
      }
      throw err;
    }
  }},

  // --- Upload route ---

  { method: "POST", path: "/upload", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    let buf;
    try {
      buf = await readRawBody(req, MAX_UPLOAD_BYTES);
    } catch {
      return json(res, 413, { error: "File too large (max 10 MB)" });
    }
    const ext = detectImage(buf);
    if (!ext) {
      return json(res, 400, { error: "Not a supported image type" });
    }
    const uploadsDir = join(DATA_DIR, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const filename = `${randomUUID()}.${ext}`;
    const filePath = join(uploadsDir, filename);
    writeFileSync(filePath, buf);
    json(res, 200, { path: filePath });
  }},

  // --- App routes ---

  { method: "GET", path: "/ssh/password", handler: (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    json(res, 200, { password: SSH_PASSWORD });
  }},

  { method: "GET", path: "/shortcuts", handler: async (req, res) => {
    const result = await daemonRPC({ type: "get-shortcuts" });
    json(res, 200, result.shortcuts);
  }},

  { method: "PUT", path: "/shortcuts", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const state = loadState();
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    const data = await parseJSON(req);
    const result = await daemonRPC({ type: "set-shortcuts", data });
    json(res, result.error ? 400 : 200, result.error ? { error: result.error } : { ok: true });
  }},

  { method: "GET", path: "/sessions", handler: async (req, res) => {
    const result = await daemonRPC({ type: "list-sessions" });
    json(res, 200, result.sessions);
  }},

  { method: "POST", path: "/sessions", handler: async (req, res) => {
    const { name } = await parseJSON(req);
    const sessionName = SessionName.tryCreate(name);
    if (!sessionName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "create-session", name: sessionName.toString() });
    json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
  }},

  { method: "DELETE", prefix: "/sessions/", handler: async (req, res, name) => {
    const result = await daemonRPC({ type: "delete-session", name });
    json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true });
  }},

  { method: "PUT", prefix: "/sessions/", handler: async (req, res, name) => {
    const { name: newName } = await parseJSON(req);
    const sessionName = SessionName.tryCreate(newName);
    if (!sessionName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "rename-session", oldName: name, newName: sessionName.toString() });
    json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
  }},
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.path && route.path === pathname) return { route, param: null };
    if (route.prefix && pathname.startsWith(route.prefix)) {
      return { route, param: decodeURIComponent(pathname.slice(route.prefix.length)) };
    }
  }
  return null;
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Add HSTS header for HTTPS requests
  if (req.socket.encrypted) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // HTTPS enforcement: only allow specific paths on HTTP for certificate installation
  // Everything else requires HTTPS (or localhost)
  if (!req.socket.encrypted && !isLocalRequest(req)) {
    // Allow explicitly listed paths on HTTP (cert installation flow)
    if (!HTTP_ALLOWED_PATHS.includes(pathname)) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.get("katulong_session");
      const state = loadState();
      if (token && state && validateSession(state, token)) {
        // Has valid session (cert installed) → redirect to HTTPS
        const host = (req.headers.host || "").replace(/:\d+$/, "");
        res.writeHead(302, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
        res.end();
        return;
      }
      // No valid session → determine where to redirect based on access method
      const host = (req.headers.host || "").split(":")[0];
      const isLanAccess = host === "katulong.local" ||
                         /^\d+\.\d+\.\d+\.\d+$/.test(host) ||  // IP address
                         host === "localhost" ||
                         host === "127.0.0.1";

      // LAN access needs certificate trust flow, internet access goes directly to login
      const redirectTo = isLanAccess ? "/connect/trust" : "/login";

      // Prevent redirect loop - don't redirect if already on the target page
      if (pathname !== redirectTo) {
        res.writeHead(302, { Location: redirectTo });
        res.end();
        return;
      }
      // If already on target page, allow it through to be served
    }
  }

  // Auth middleware: redirect unauthenticated requests to /login
  if (!isPublicPath(pathname) && !isAuthenticated(req)) {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  // Refresh session activity for authenticated requests (sliding expiry)
  // Skip for localhost (auto-authenticated) and public paths
  if (!isPublicPath(pathname) && !isLocalRequest(req) && process.env.KATULONG_NO_AUTH !== "1") {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get("katulong_session");
    if (token) {
      // Fire and forget - don't block request processing
      refreshSessionActivity(token).catch(err => {
        log.error("Failed to refresh session activity", { error: err.message });
      });
    }
  }

  const match = matchRoute(req.method, pathname);

  if (match) {
    // Apply rate limiting to auth endpoints
    const authPaths = ["/auth/register/options", "/auth/register/verify", "/auth/login/options", "/auth/login/verify"];
    const pairingPaths = ["/auth/pair/verify"];

    if (pairingPaths.includes(pathname)) {
      // Check pairing rate limit (stricter)
      const rateLimitResult = await new Promise((resolve) => {
        pairingRateLimit(req, res, () => resolve(true));
      });
      if (!rateLimitResult) return; // Rate limit exceeded, response already sent
    } else if (authPaths.includes(pathname)) {
      // Check auth rate limit
      const rateLimitResult = await new Promise((resolve) => {
        authRateLimit(req, res, () => resolve(true));
      });
      if (!rateLimitResult) return; // Rate limit exceeded, response already sent
    }

    try {
      await match.route.handler(req, res, match.param);
    } catch (err) {
      if (err instanceof SyntaxError) {
        json(res, 400, { error: "Invalid JSON" });
      } else if (err.message === "Request body too large") {
        json(res, 413, { error: "Request body too large" });
      } else if (err.message === "Daemon not connected") {
        json(res, 503, { error: "Service temporarily unavailable" });
      } else {
        // Log the actual error for debugging, but return generic message to client
        log.error("Request handler error", { path: req.url, error: err.message, stack: err.stack });
        json(res, 500, { error: "Internal server error" });
      }
    }
    return;
  }

  // Static files
  const publicDir = join(__dirname, "public");
  const filePath = resolve(publicDir, pathname.slice(1));
  if (req.method === "GET" && filePath.startsWith(publicDir) && existsSync(filePath)) {
    try {
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(readFileSync(filePath));
    } catch (err) {
      log.error("Static file read error", { path: pathname, error: err.message });
      res.writeHead(500);
      res.end("Internal server error");
    }
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = createServer(handleRequest);
const httpsServer = createHttpsServer({
  cert: readFileSync(tlsPaths.serverCert),
  key: readFileSync(tlsPaths.serverKey),
}, handleRequest);

// --- WebSocket ---

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map(); // clientId -> { ws, session, p2pPeer, p2pConnected }

function handleUpgrade(req, socket, head) {
  log.info("WebSocket upgrade attempt", {
    ip: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host
  });

  // Validate session cookie on WebSocket upgrade
  if (!isAuthenticated(req)) {
    log.warn("WebSocket rejected: not authenticated", { ip: req.socket.remoteAddress });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  log.info("WebSocket authenticated", { ip: req.socket.remoteAddress });

  // Origin check to prevent Cross-Site WebSocket Hijacking (CSWSH)
  // Localhost bypasses this since browsers may omit Origin for local pages
  if (!isLocalRequest(req)) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (!origin) {
      log.warn("WebSocket rejected: missing Origin header");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        log.warn("WebSocket origin mismatch", { origin, host });
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

server.on("upgrade", handleUpgrade);
httpsServer.on("upgrade", handleUpgrade);

// Relay daemon broadcasts to matching browser clients
function sendToSession(sessionName, payload, { preferP2P = false } = {}) {
  const encoded = JSON.stringify(payload);
  for (const [, info] of wsClients) {
    if (info.session !== sessionName) continue;
    if (preferP2P && info.p2pConnected && info.p2pPeer) {
      try {
        info.p2pPeer.send(encoded);
        continue;
      } catch {
        // DataChannel send failed, fall through to WS
      }
    }
    if (info.ws.readyState === 1) {
      info.ws.send(encoded);
    }
  }
}

let sshRelay = null;

function relayBroadcast(msg) {
  switch (msg.type) {
    case "output":
      sendToSession(msg.session, { type: "output", data: msg.data });
      break;
    case "exit":
      sendToSession(msg.session, { type: "exit", code: msg.code });
      break;
    case "session-removed":
      sendToSession(msg.session, { type: "session-removed" });
      break;
    case "session-renamed":
      sendToSession(msg.session, { type: "session-renamed", name: msg.newName });
      for (const [, info] of wsClients) {
        if (info.session === msg.session) info.session = msg.newName;
      }
      break;
  }
  sshRelay?.relayBroadcast(msg);
}

wss.on("connection", (ws) => {
  const clientId = randomUUID();
  log.debug("Client connected", { clientId });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Validate message structure and types
    const validation = validateMessage(msg);
    if (!validation.valid) {
      log.warn("Invalid WebSocket message", { clientId, error: validation.error, type: msg?.type });
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      return;
    }

    if (msg.type === "attach") {
      const name = msg.session || "default";
      try {
        const result = await daemonRPC({ type: "attach", clientId, session: name, cols: msg.cols, rows: msg.rows });
        wsClients.set(clientId, { ws, session: name, p2pPeer: null, p2pConnected: false });
        log.debug("Client attached", { clientId, session: name });
        ws.send(JSON.stringify({ type: "attached" }));
        if (result.buffer) ws.send(JSON.stringify({ type: "output", data: result.buffer }));
        if (!result.alive) ws.send(JSON.stringify({ type: "exit", code: -1 }));
      } catch (err) {
        log.error("Attach failed", { clientId, error: err.message });
        ws.send(JSON.stringify({ type: "error", message: "Daemon not available" }));
      }
    } else if (msg.type === "input") {
      daemonSend({ type: "input", clientId, data: msg.data });
    } else if (msg.type === "resize") {
      daemonSend({ type: "resize", clientId, cols: msg.cols, rows: msg.rows });
    } else if (msg.type === "p2p-signal") {
      const info = wsClients.get(clientId);
      if (!info) return;

      // If this is a new SDP offer, tear down the old peer and start fresh
      if (msg.data?.type === "offer" && info.p2pPeer) {
        destroyPeer(info.p2pPeer);
        info.p2pPeer = null;
        info.p2pConnected = false;
      }

      if (!info.p2pPeer) {
        info.p2pPeer = createServerPeer(
          // onSignal: relay SDP/ICE back to browser via WS
          (data) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "p2p-signal", data }));
            }
          },
          // onData: terminal input from browser via DataChannel
          (chunk) => {
            try {
              const parsed = JSON.parse(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
              if (parsed.type === "input") {
                daemonSend({ type: "input", clientId, data: parsed.data });
              }
            } catch (err) {
              log.warn("Malformed P2P data", { clientId, error: err.message });
            }
          },
          // onClose: clean up P2P state, notify browser
          () => {
            const cur = wsClients.get(clientId);
            if (cur) {
              cur.p2pPeer = null;
              cur.p2pConnected = false;
            }
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "p2p-closed" }));
            }
          },
        );

        // Mark connected when DataChannel opens
        info.p2pPeer.on("connect", () => {
          const cur = wsClients.get(clientId);
          if (cur) cur.p2pConnected = true;
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "p2p-ready" }));
          }
        });
      }

      // Feed the signal data to the peer
      info.p2pPeer.signal(msg.data);
    }
  });

  ws.on("close", () => {
    log.debug("Client disconnected", { clientId });
    const info = wsClients.get(clientId);
    if (info?.p2pPeer) destroyPeer(info.p2pPeer);
    wsClients.delete(clientId);
    daemonSend({ type: "detach", clientId });
  });
});

// Live-reload (dev only)
if (process.env.NODE_ENV !== "production") {
  watch(join(__dirname, "public"), { recursive: true }, () => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify({ type: "reload" }));
    }
  });
}

process.on("unhandledRejection", (err) => {
  log.error("Unhandled rejection", { error: err?.message || String(err) });
});

server.listen(PORT, "0.0.0.0", () => {
  log.info("Katulong HTTP started", { port: PORT });
});

httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
  const lanIP = getLanIP();
  log.info("Katulong HTTPS started", {
    port: HTTPS_PORT,
    trustUrl: lanIP ? `http://${lanIP}:${PORT}/connect/trust` : null,
  });
});

// --- mDNS: advertise katulong.local on the LAN ---
{
  const mdnsIP = getLanIP();
  if (mdnsIP) {
    try {
      const mdnsServer = mdns();
      mdnsServer.on("query", (query) => {
        for (const q of query.questions) {
          if (q.name === "katulong.local" && (q.type === "A" || q.type === "ANY")) {
            mdnsServer.respond({
              answers: [{ name: "katulong.local", type: "A", ttl: 120, data: mdnsIP }],
            });
            break;
          }
        }
      });
      mdnsServer.on("error", (err) => {
        log.warn("mDNS error", { error: err.message });
      });
      log.info("mDNS advertising katulong.local", { ip: mdnsIP });
    } catch (err) {
      log.warn("Failed to start mDNS", { error: err.message });
    }
  }
}

sshRelay = startSSHServer({
  port: SSH_PORT,
  hostKey: sshHostKey,
  password: SSH_PASSWORD,
  daemonRPC,
  daemonSend,
  credentialLockout,
});
