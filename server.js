import "dotenv/config";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFileSync, existsSync, watch, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { encode, decoder } from "./lib/ndjson.js";
import { log } from "./lib/log.js";
import { createServerPeer, destroyPeer, initP2P, p2pAvailable } from "./lib/p2p.js";
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
  isAllowedCorsOrigin,
} from "./lib/http-util.js";
import { rateLimit, getClientIp } from "./lib/rate-limit.js";
import {
  processRegistration,
  processAuthentication,
  extractChallenge,
} from "./lib/auth-handlers.js";
import { SessionName } from "./lib/session-name.js";
import { AuthState } from "./lib/auth-state.js";
import { ConfigManager } from "./lib/config.js";
import { ensureHostKey, startSSHServer } from "./lib/ssh.js";
import { validateMessage } from "./lib/websocket-validation.js";
import { CredentialLockout } from "./lib/credential-lockout.js";
import { isLocalRequest, getAccessMethod, isLoopbackAddress, TUNNEL_HOSTNAMES } from "./lib/access-method.js";
import { serveStaticFile } from "./lib/static-files.js";
import { createTransportBridge } from "./lib/transport-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const DATA_DIR = process.env.KATULONG_DATA_DIR || __dirname;
const SSH_PORT = parseInt(process.env.SSH_PORT || "2222", 10);

// Helper: Determine if connection is HTTPS (for setting Secure cookie flag)
function isHttpsConnection(req) {
  if (req.socket?.encrypted) return true;
  const hostname = (req.headers.host || 'localhost').split(':')[0];
  // Known HTTPS-only tunnel services
  if (TUNNEL_HOSTNAMES.some(suffix => hostname.endsWith(suffix))) return true;
  // Cloudflare Tunnel with custom domain: socket is loopback (from cloudflared)
  // and CF-Connecting-IP header present (added by Cloudflare edge, not forgeable
  // since the connection is local)
  const addr = req.socket?.remoteAddress || "";
  if (isLoopbackAddress(addr) && req.headers["cf-connecting-ip"]) return true;
  return false;
}

// --- Configuration (load instance name first) ---

const configManager = new ConfigManager(DATA_DIR);
configManager.initialize();
const instanceName = configManager.getInstanceName();
const instanceId = configManager.getInstanceId();
log.info("Configuration loaded", { instanceName, instanceId });

await initP2P();

const sshHostKey = ensureHostKey(DATA_DIR);

// --- Authentication tokens ---
// Setup token is now stored in AuthState (managed via API)
// SSH access token is still generated here
const SSH_PASSWORD = process.env.SSH_PASSWORD || randomBytes(16).toString("hex");
const RP_NAME = "Katulong";

// --- Rate limiting ---
// 10 attempts per minute for auth endpoints
const authRateLimit = rateLimit(10, 60000, (req) => {
  const addr = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const origin = req.headers['origin'] || req.headers['host'] || '';
  return `${addr}:${ua}:${origin}`;
});

if (!process.env.SSH_PASSWORD) {
  log.info("SSH password generated (retrieve via GET /ssh/password)");
}

if (process.env.KATULONG_NO_AUTH === "1") {
  log.warn("WARNING: KATULONG_NO_AUTH=1 — authentication is DISABLED. All requests are treated as authenticated. Do NOT use this in production or on untrusted networks.");
}

// --- Constants ---

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB limit for request bodies
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DAEMON_RECONNECT_INITIAL_MS = 1000; // 1 second
const DAEMON_RECONNECT_MAX_MS = 30000; // 30 seconds

// --- Challenge storage (in-memory, 5-min expiry) ---

const { store: storeChallenge, consume: consumeChallenge, _challenges: challenges } = createChallengeStore(CHALLENGE_TTL_MS);

// --- Credential lockout (in-memory, 15 min window) ---

const credentialLockout = new CredentialLockout({
  maxAttempts: 5,        // 5 failures
  windowMs: 15 * 60 * 1000,  // within 15 minutes
  lockoutMs: 15 * 60 * 1000, // locks for 15 minutes
});

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
      bridge.relay(msg);
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

// --- Security headers middleware ---

function setSecurityHeaders(res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

// --- HTTP routes ---

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
      ...getCspHeaders(false, req)
    });
    res.end(html);
  }},

  { method: "GET", path: "/manifest.json", handler: (req, res) => {
    const manifest = readFileSync(join(__dirname, "public", "manifest.json"), "utf-8");
    res.writeHead(200, { "Content-Type": "application/manifest+json" });
    res.end(manifest);
  }},

  { method: "GET", path: "/login", handler: (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      ...getCspHeaders(false, req)
    });
    res.end(readFileSync(join(__dirname, "public", "login.html"), "utf-8"));
  }},

  // --- Auth routes ---

  { method: "GET", path: "/auth/status", handler: (req, res) => {
    // CORS: strict allowlist — never reflect arbitrary origins with credentials.
    // Only the server's own origin (tunnel or localhost) is allowed, preventing
    // third-party sites from making credentialed cross-origin requests.
    const origin = req.headers.origin;
    if (origin) {
      const { origin: serverOrigin } = getOriginAndRpID(req);
      if (isAllowedCorsOrigin(origin, serverOrigin, PORT)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      // Disallowed origins: omit CORS headers (browser enforces the cross-origin block)
    }
    const accessMethod = getAccessMethod(req);
    json(res, 200, {
      setup: isSetup(),
      accessMethod  // "localhost" or "internet"
    });
  }},

  { method: "POST", path: "/auth/register/options", handler: async (req, res) => {
    const { setupToken } = await parseJSON(req);

    // Get state (or create empty if first time)
    let state = loadState();
    if (!state) {
      state = await withStateLock((currentState) => {
        if (currentState) return currentState;
        // First time - create empty state
        const newState = AuthState.empty();
        log.info("First time setup - empty state created");
        return newState;
      });
    }

    // First registration from localhost doesn't require a token
    const isFirstRegistration = !isSetup();
    const isLocal = isLocalRequest(req);

    if (isFirstRegistration && isLocal) {
      // Allow first registration from localhost without token
      log.info("First passkey registration from localhost - no token required");
    } else {
      // Validate setup token (API-managed tokens)
      const tokenData = state.findSetupToken(setupToken);
      if (!tokenData) {
        return json(res, 403, { error: "Invalid setup token" });
      }

      // Update lastUsedAt for the token (inside lock to prevent race)
      await withStateLock((currentState) => {
        return currentState.updateSetupToken(tokenData.id, { lastUsedAt: Date.now() });
      });
    }
    const { origin, rpID } = getOriginAndRpID(req);
    let opts, userID;
    if (isSetup()) {
      const state = loadState();
      // Handle case where credentials exist but user is null (shouldn't happen, but defensive)
      if (state.user && state.user.id) {
        ({ opts, userID } = await generateRegistrationOptsForUser(state.user.id, RP_NAME, rpID, origin));
      } else {
        // Fallback: create new user if somehow credentials exist without user
        ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, origin));
      }
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

    // Find setup token ID (if provided)
    let setupTokenId = null;
    if (setupToken) {
      const state = loadState();
      const tokenData = state?.findSetupToken(setupToken);
      if (tokenData) {
        setupTokenId = tokenData.id;
      }
    }

    // Process registration inside lock to prevent race conditions
    const result = await withStateLock(async (currentState) => {
      const result = await processRegistration({
        credential,
        challenge,
        challengeValid,
        userID,
        origin,
        rpID,
        currentState,
        deviceId,
        deviceName,
        userAgent,
        setupTokenId, // Pass token ID to link credential to token
      });

      if (!result.success) {
        // Return error info without saving (state unchanged)
        return { result };
      }

      // Link credential to setup token
      let updatedState = result.data.updatedState;
      if (setupTokenId && result.data.credentialId) {
        updatedState = updatedState.updateSetupToken(setupTokenId, {
          credentialId: result.data.credentialId,
        });
      }

      // Return updated state and success result
      return { state: updatedState, result };
    });

    // I/O: Handle result
    if (!result.result.success) {
      return json(res, result.result.statusCode, { error: result.result.message });
    }

    // I/O: Set cookie
    const { session } = result.result.data;
    setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });

    // Broadcast to all connected clients (for real-time UI updates)
    if (setupTokenId) {
      broadcastToAll({ type: "credential-registered", tokenId: setupTokenId });
    }

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

    // Process authentication inside lock to prevent race conditions
    const result = await withStateLock(async (currentState) => {
      const result = await processAuthentication({
        credential,
        challenge,
        challengeValid,
        origin,
        rpID,
        currentState,
      });

      if (!result.success) {
        // Return error info without saving (state unchanged)
        return { result };
      }

      // Return updated state and success result
      return { state: result.data.updatedState, result };
    });

    // I/O: Handle result
    if (!result.result.success) {
      // Record failed attempt
      const lockout = credentialLockout.recordFailure(credential.id);
      if (lockout.locked) {
        return json(res, 403, {
          error: `Too many failed attempts. Account locked for ${lockout.retryAfter} seconds.`,
          retryAfter: lockout.retryAfter,
        });
      }
      return json(res, result.result.statusCode, { error: result.result.message });
    }

    // Success: reset lockout counter
    credentialLockout.recordSuccess(credential.id);

    // I/O: Set cookie
    const { session } = result.result.data;
    setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });
    json(res, 200, { ok: true });
  }},

  // --- Credential API (direct credential management) ---

  { method: "GET", path: "/api/credentials", handler: (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const state = loadState();
    if (!state) {
      return json(res, 200, { credentials: [] });
    }

    // Return all credentials with metadata (without sensitive fields like publicKey)
    const credentials = state.credentials.map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      userAgent: c.userAgent,
      setupTokenId: c.setupTokenId || null,
    }));

    json(res, 200, { credentials });
  }},

  { method: "DELETE", prefix: "/api/credentials/", handler: async (req, res, param) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }

    const credentialId = param;
    if (!credentialId) {
      return json(res, 400, { error: "Credential ID is required" });
    }

    let removedCredentialId = null;
    try {
      const result = await withStateLock((state) => {
        if (!state) {
          return { found: false };
        }

        const credential = state.getCredential(credentialId);
        if (!credential) {
          return { found: false };
        }

        const allowRemoveLast = isLocalRequest(req);
        const updatedState = state.removeCredential(credentialId, { allowRemoveLast });
        return { state: updatedState, found: true, removedCredentialId: credentialId };
      });

      if (!result.found) {
        return json(res, 404, { error: "Credential not found" });
      }

      removedCredentialId = result.removedCredentialId;
    } catch (err) {
      if (err.message && err.message.includes('last credential')) {
        return json(res, 403, { error: "Cannot remove the last credential — would lock you out" });
      }
      throw err;
    }

    // SECURITY: Immediately close all active WebSocket connections for this credential
    if (removedCredentialId) {
      closeWebSocketsForCredential(removedCredentialId);
    }

    log.info("Credential revoked directly", { credentialId });
    json(res, 200, { ok: true });
  }},

  // --- Setup token API (GitHub-style token management) ---

  { method: "GET", path: "/api/tokens", handler: (req, res) => {
    // Only authenticated users can view tokens
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const state = loadState();
    if (!state) {
      return json(res, 200, { tokens: [] });
    }

    // Return token metadata with linked credential info (without actual token values for security)
    const tokens = state.setupTokens.map(t => {
      const tokenData = {
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        expiresAt: t.expiresAt || null,
        credential: null, // Will be populated if token was used
      };

      // If token was used to register a credential, include credential info
      if (t.credentialId) {
        const credential = state.getCredential(t.credentialId);
        if (credential) {
          tokenData.credential = {
            id: credential.id,
            name: credential.name,
            createdAt: credential.createdAt,
            lastUsedAt: credential.lastUsedAt,
            userAgent: credential.userAgent,
          };
        }
      }

      return tokenData;
    });

    json(res, 200, { tokens });
  }},

  { method: "POST", path: "/api/tokens", handler: async (req, res) => {
    // Only authenticated users can create tokens
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    // CSRF not needed for localhost (auth bypassed, no session to protect)
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }

    const { name } = await parseJSON(req);
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return json(res, 400, { error: "Token name is required" });
    }

    // Create token inside lock to prevent race conditions
    const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const tokenData = await withStateLock((state) => {
      const tokenValue = randomBytes(16).toString("hex");
      const now = Date.now();
      const tokenData = {
        id: randomBytes(8).toString("hex"),
        token: tokenValue,
        name: name.trim(),
        createdAt: now,
        lastUsedAt: null,
        expiresAt: now + SETUP_TOKEN_TTL_MS,
      };

      const newState = (state || AuthState.empty()).addSetupToken(tokenData);
      return { state: newState, tokenData };
    });

    log.info("Setup token created", { id: tokenData.tokenData.id, name: tokenData.tokenData.name });

    // Return the token value only once (on creation)
    json(res, 200, {
      id: tokenData.tokenData.id,
      name: tokenData.tokenData.name,
      token: tokenData.tokenData.token,
      createdAt: tokenData.tokenData.createdAt,
      expiresAt: tokenData.tokenData.expiresAt,
    });
  }},

  { method: "DELETE", prefix: "/api/tokens/", handler: async (req, res, param) => {
    // Only authenticated users can delete tokens
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    // CSRF not needed for localhost (auth bypassed, no session to protect)
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }

    const id = param;
    if (!id) {
      return json(res, 400, { error: "Token ID is required" });
    }

    // Delete token (and its linked credential) inside lock to prevent race conditions
    let result;
    try {
      result = await withStateLock((state) => {
        if (!state) {
          return { found: false };
        }

        const token = state.setupTokens.find(t => t.id === id);
        if (!token) {
          return { found: false };
        }

        let updatedState = state;
        let removedCredentialId = null;

        // If token has a linked credential, remove the credential and its sessions
        if (token.credentialId) {
          const credential = state.getCredential(token.credentialId);
          if (credential) {
            const allowRemoveLast = isLocalRequest(req);
            // This will throw if it's the last credential and not from localhost
            updatedState = updatedState.removeCredential(token.credentialId, { allowRemoveLast });
            removedCredentialId = token.credentialId;
          }
        }

        // Remove the setup token
        updatedState = updatedState.removeSetupToken(id);

        return { state: updatedState, found: true, removedCredentialId };
      });
    } catch (err) {
      if (err.message && err.message.includes('last credential')) {
        return json(res, 403, { error: "Cannot revoke the last credential — would lock you out" });
      }
      throw err;
    }

    if (!result.found) {
      return json(res, 404, { error: "Token not found" });
    }

    // SECURITY: Close all active WebSocket connections for the revoked credential
    if (result.removedCredentialId) {
      closeWebSocketsForCredential(result.removedCredentialId);
    }

    log.info("Setup token revoked", { id, credentialRevoked: !!result.removedCredentialId });
    json(res, 200, { ok: true });
  }},

  { method: "PATCH", prefix: "/api/tokens/", handler: async (req, res, param) => {
    // Only authenticated users can update tokens
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    // CSRF not needed for localhost (auth bypassed, no session to protect)
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }

    const id = param;
    if (!id) {
      return json(res, 400, { error: "Token ID is required" });
    }

    const { name } = await parseJSON(req);
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return json(res, 400, { error: "Token name is required" });
    }

    // Update token inside lock to prevent race conditions
    const result = await withStateLock((state) => {
      if (!state) {
        // No state file exists, so token not found
        return { found: false };
      }

      const tokenExists = state.setupTokens.some(t => t.id === id);
      if (!tokenExists) {
        // Token not found, state unchanged
        return { found: false };
      }

      // Token found, update it
      return { state: state.updateSetupToken(id, { name: name.trim() }), found: true };
    });

    if (!result.found) {
      return json(res, 404, { error: "Token not found" });
    }

    log.info("Setup token updated", { id, name: name.trim() });
    json(res, 200, { ok: true });
  }},

  { method: "POST", path: "/auth/logout", handler: async (req, res) => {
    const state = loadState();
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get("katulong_session");
    if (token) {
      try {
        // Use withStateLock for atomic state modification
        // endSession() permanently removes the credential and all its sessions
        const newState = await withStateLock(async (state) => {
          if (state && state.isValidSession(token)) {
            return state.endSession(token, { allowRemoveLast: isLocalRequest(req) });
          }
          return state;
        });

        // Notify all connected clients if a credential was removed
        if (newState && newState.removedCredentialId) {
          broadcastToAll({ type: 'credential-removed', credentialId: newState.removedCredentialId });
          // SECURITY: Immediately close all WebSocket connections for the revoked credential
          closeWebSocketsForCredential(newState.removedCredentialId);
        }
      } catch (err) {
        // Handle "last credential" protection
        if (err.message && err.message.includes('last credential')) {
          return json(res, 403, { error: "Cannot end session for the last credential" });
        }
        throw err; // Re-throw unexpected errors
      }
    }
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
  }},

  { method: "POST", path: "/auth/revoke-all", handler: async (req, res) => {
    const state = loadState();
    if (!state) return json(res, 400, { error: "Not set up" });
    if (!validateCsrfToken(req, state)) {
      return json(res, 403, { error: "Invalid or missing CSRF token" });
    }
    await withStateLock((currentState) => {
      if (!currentState) return currentState;
      return currentState.revokeAllSessions();
    });
    // SECURITY: Close all non-localhost WebSocket connections
    for (const [clientId, info] of wsClients) {
      if (info.ws.readyState === 1) {
        info.ws.close(1008, "All sessions revoked");
      }
      wsClients.delete(clientId);
    }
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
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
    json(res, 200, { path: `/uploads/${filename}` });
  }},

  // --- App routes ---

  { method: "GET", path: "/ssh/password", handler: (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    json(res, 200, { password: SSH_PASSWORD });
  }},

  { method: "GET", path: "/shortcuts", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
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
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const result = await daemonRPC({ type: "list-sessions" });
    json(res, 200, result.sessions);
  }},

  { method: "POST", path: "/sessions", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }
    const { name } = await parseJSON(req);
    const sessionName = SessionName.tryCreate(name);
    if (!sessionName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "create-session", name: sessionName.toString() });
    json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
  }},

  { method: "DELETE", prefix: "/sessions/", handler: async (req, res, name) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }
    const result = await daemonRPC({ type: "delete-session", name });
    json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true });
  }},

  { method: "PUT", prefix: "/sessions/", handler: async (req, res, name) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    if (!isLocalRequest(req)) {
      const state = loadState();
      if (!validateCsrfToken(req, state)) {
        return json(res, 403, { error: "Invalid or missing CSRF token" });
      }
    }
    const { name: newName } = await parseJSON(req);
    const sessionName = SessionName.tryCreate(newName);
    if (!sessionName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "rename-session", oldName: name, newName: sessionName.toString() });
    json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
  }},

  // --- Config API ---
  { method: "GET", path: "/api/config", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const config = configManager.getConfig();
    json(res, 200, { config });
  }},

  { method: "PUT", path: "/api/config/instance-name", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const { instanceName } = await parseJSON(req);

    try {
      configManager.setInstanceName(instanceName);
      log.info("Instance name updated", { instanceName });
      json(res, 200, { success: true, instanceName: configManager.getInstanceName() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  }},

  { method: "PUT", path: "/api/config/instance-icon", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const { instanceIcon } = await parseJSON(req);

    try {
      configManager.setInstanceIcon(instanceIcon);
      log.info("Instance icon updated", { instanceIcon });
      json(res, 200, { success: true, instanceIcon: configManager.getInstanceIcon() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
  }},

  { method: "PUT", path: "/api/config/toolbar-color", handler: async (req, res) => {
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }

    const { toolbarColor } = await parseJSON(req);

    try {
      configManager.setToolbarColor(toolbarColor);
      log.info("Toolbar color updated", { toolbarColor });
      json(res, 200, { success: true, toolbarColor: configManager.getToolbarColor() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
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

  // Apply security headers to every response
  setSecurityHeaders(res);

  // Auth middleware: redirect unauthenticated requests
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

    if (authPaths.includes(pathname)) {
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
  if (req.method === "GET") {
    const publicDir = join(__dirname, "public");
    const served = serveStaticFile(res, publicDir, pathname);
    if (served) {
      return; // File was served successfully
    }
  }

  // 404 - Not found
  res.writeHead(404);
  res.end("Not found");
}

const server = createServer(handleRequest);

// --- WebSocket ---

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map(); // clientId -> { ws, session, sessionToken, credentialId, p2pPeer, p2pConnected }

function handleUpgrade(req, socket, head) {
  log.info("WebSocket upgrade attempt", {
    ip: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host
  });

  // Validate session cookie on WebSocket upgrade and extract session info
  if (!isAuthenticated(req)) {
    log.warn("WebSocket rejected: not authenticated", { ip: req.socket.remoteAddress });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Extract session token and validate credential
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.get("katulong_session");
  let credentialId = null;

  if (sessionToken && !isLocalRequest(req)) {
    const state = loadState();
    const session = state.getSession(sessionToken);
    if (!session || !state.isValidSession(sessionToken)) {
      log.warn("WebSocket rejected: invalid session", { ip: req.socket.remoteAddress });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    credentialId = session.credentialId;
  }

  log.info("WebSocket authenticated", { ip: req.socket.remoteAddress, credentialId });

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
    // Attach session info to WebSocket for tracking
    ws.sessionToken = sessionToken;
    ws.credentialId = credentialId;
    wss.emit("connection", ws, req);
  });
}

server.on("upgrade", handleUpgrade);

// Relay daemon broadcasts to matching browser clients
function sendToSession(sessionName, payload, { preferP2P = false } = {}) {
  const encoded = JSON.stringify(payload);
  for (const [, info] of wsClients) {
    if (info.session !== sessionName) continue;
    if (preferP2P && info.p2pConnected && info.p2pPeer) {
      try {
        info.p2pPeer.send(encoded);
        continue; // Only skip WS if P2P send succeeded
      } catch { /* fall through to WS */ }
    }
    if (info.ws.readyState === 1) {
      info.ws.send(encoded);
    }
  }
}

// Broadcast to all connected WebSocket clients
function broadcastToAll(payload) {
  const encoded = JSON.stringify(payload);
  for (const [, info] of wsClients) {
    if (info.ws.readyState === 1) {
      info.ws.send(encoded);
    }
  }
}

/**
 * Close all WebSocket connections for a revoked credential
 * SECURITY: This ensures that revoking a device/credential immediately
 * disconnects all active sessions using that credential.
 * @param {string} credentialId - Credential ID to revoke
 */
function closeWebSocketsForCredential(credentialId) {
  let closedCount = 0;
  for (const [clientId, info] of wsClients) {
    if (info.credentialId === credentialId) {
      log.info("Closing WebSocket for revoked credential", { clientId, credentialId });

      // Close P2P connection if exists
      if (info.p2pPeer) {
        try { destroyPeer(info.p2pPeer); } catch (err) {
          log.warn("Error destroying P2P peer", { error: err.message });
        }
      }

      // Close WebSocket with appropriate code
      if (info.ws.readyState === 1) { // OPEN
        info.ws.close(1008, "Credential revoked"); // 1008 = Policy Violation
      }

      wsClients.delete(clientId);
      closedCount++;
    }
  }

  if (closedCount > 0) {
    log.info("Closed WebSocket connections for revoked credential", { credentialId, count: closedCount });
  }
}

const bridge = createTransportBridge();

// Register WebSocket transport
bridge.register((msg) => {
  switch (msg.type) {
    case "output":
      sendToSession(msg.session, { type: "output", data: msg.data }, { preferP2P: true });
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
});

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

    // SECURITY: Validate session is still valid before processing message
    // This catches cases where a credential was revoked after the WebSocket connected
    if (ws.sessionToken) {
      const state = loadState();
      if (!state || !state.isValidSession(ws.sessionToken)) {
        log.warn("WebSocket message rejected: session no longer valid", { clientId, credentialId: ws.credentialId });
        ws.close(1008, "Session invalidated"); // 1008 = Policy Violation
        wsClients.delete(clientId);
        return;
      }
    }

    if (msg.type === "attach") {
      const name = msg.session || "default";
      try {
        const result = await daemonRPC({ type: "attach", clientId, session: name, cols: msg.cols, rows: msg.rows });
        wsClients.set(clientId, {
          ws,
          session: name,
          sessionToken: ws.sessionToken,
          credentialId: ws.credentialId,
          p2pPeer: null,
          p2pConnected: false,
        });
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

      if (!p2pAvailable) {
        ws.send(JSON.stringify({ type: "p2p-unavailable" }));
        return;
      }

      // If this is a new SDP offer, tear down the old peer and start fresh
      if (msg.data?.type === "offer" && info.p2pPeer) {
        destroyPeer(info.p2pPeer);
        info.p2pPeer = null;
        info.p2pConnected = false;
      }

      if (!info.p2pPeer) {
        info.p2pPeer = createServerPeer(
          // onSignal: relay back to browser
          (data) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: "p2p-signal", data }));
            }
          },
          // onData: terminal input via P2P DataChannel
          (chunk) => {
            try {
              const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
              const p2pMsg = JSON.parse(str);
              if (p2pMsg.type === "input") {
                daemonSend({ type: "input", clientId, data: p2pMsg.data });
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
          }
        );

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

  ws.on("error", (err) => {
    log.error("WebSocket client error", { clientId, error: err.message });
    const info = wsClients.get(clientId);
    if (info?.p2pPeer) destroyPeer(info.p2pPeer);
    wsClients.delete(clientId);
    daemonSend({ type: "detach", clientId });
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
  const watcher = watch(join(__dirname, "public"), { recursive: true }, () => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify({ type: "reload" }));
    }
  });
  watcher.on("error", (err) => {
    log.warn("Live-reload watcher error", { error: err.message });
  });
}

process.on("unhandledRejection", (err) => {
  log.error("Unhandled rejection", { error: err?.message || String(err) });
});

server.listen(PORT, "0.0.0.0", () => {
  log.info("Katulong HTTP started", { port: PORT });
});

startSSHServer({
  port: SSH_PORT,
  hostKey: sshHostKey,
  password: SSH_PASSWORD,
  daemonRPC,
  daemonSend,
  credentialLockout,
  bridge,
});
