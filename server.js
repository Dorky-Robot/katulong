import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync, existsSync, watch, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import envConfig, { ensureDataDir } from "./lib/env-config.js";
import { log } from "./lib/log.js";
import { createServerPeer, destroyPeer, initP2P, p2pAvailable } from "./lib/p2p.js";
import {
  loadState, validateSession, refreshSessionActivity,
} from "./lib/auth.js";
import {
  parseCookies, isPublicPath, createChallengeStore, validateCsrfToken,
} from "./lib/http-util.js";
import { rateLimit, getClientIp } from "./lib/rate-limit.js";
import { ConfigManager } from "./lib/config.js";
import { ensureHostKey, startSSHServer } from "./lib/ssh.js";
import { validateMessage } from "./lib/websocket-validation.js";
import { CredentialLockout } from "./lib/credential-lockout.js";
import { isLocalRequest } from "./lib/access-method.js";
import { serveStaticFile } from "./lib/static-files.js";
import { createTransportBridge } from "./lib/transport-bridge.js";
import { createDaemonClient } from "./lib/daemon-client.js";
import { createMiddleware, createAuthRoutes, createAppRoutes } from "./lib/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = envConfig.port;
const SOCKET_PATH = envConfig.socketPath;
const DATA_DIR = envConfig.dataDir;
const SSH_PORT = envConfig.sshPort;

ensureDataDir();

// --- Configuration (load instance name first) ---

const configManager = new ConfigManager(DATA_DIR);
configManager.initialize();
const instanceName = configManager.getInstanceName();
const instanceId = configManager.getInstanceId();
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")).version;
log.info("Configuration loaded", { instanceName, instanceId, version: APP_VERSION });

await initP2P();

const sshHostKey = ensureHostKey(DATA_DIR);

// --- Authentication tokens ---
// Setup token is now stored in AuthState (managed via API)
// SSH access token is still generated here (or read from SSH_PASSWORD env var)
const SSH_PASSWORD = envConfig.sshPassword;
const RP_NAME = "Katulong";

// --- Rate limiting ---
// 10 attempts per minute for auth endpoints
const authRateLimit = rateLimit(10, 60000, (req) => {
  const addr = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const origin = req.headers['origin'] || req.headers['host'] || '';
  return `${addr}:${ua}:${origin}`;
});

if (!envConfig.sshPasswordProvided) {
  log.info("SSH password generated (retrieve via GET /ssh/password)");
}

if (envConfig.noAuth) {
  log.warn("WARNING: KATULONG_NO_AUTH=1 — authentication is DISABLED. All requests are treated as authenticated. Do NOT use this in production or on untrusted networks.");
}

// --- Constants ---

const MAX_REQUEST_BODY_SIZE = 1024 * 1024; // 1MB limit for request bodies
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SERVER_PID_PATH = join(DATA_DIR, "server.pid");
const DRAIN_TIMEOUT_MS = envConfig.drainTimeout;

// --- Graceful shutdown state ---

let draining = false;

// --- Challenge storage (in-memory, 5-min expiry) ---

const { store: storeChallenge, consume: consumeChallenge, _challenges: challenges } = createChallengeStore(CHALLENGE_TTL_MS);

// --- Credential lockout (in-memory, 15 min window) ---

const credentialLockout = new CredentialLockout({
  maxAttempts: 5,        // 5 failures
  windowMs: 15 * 60 * 1000,  // within 15 minutes
  lockoutMs: 15 * 60 * 1000, // locks for 15 minutes
});

function isAuthenticated(req) {
  if (envConfig.noAuth) {
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

const bridge = createTransportBridge();
const daemon = createDaemonClient({ socketPath: SOCKET_PATH, log, bridge });
const daemonRPC = daemon.rpc;
const daemonSend = daemon.send;
daemon.connect();

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

// --- WebSocket client tracking (declared early so route factories can reference it) ---
const wsClients = new Map(); // clientId -> { ws, session, sessionToken, credentialId, p2pPeer, p2pConnected }

// --- HTTP routes (assembled from lib/routes/) ---

const { auth, csrf } = createMiddleware({ isAuthenticated, json });

const routeCtx = {
  json, parseJSON, isAuthenticated, daemonRPC,
  storeChallenge, consumeChallenge, challenges,
  broadcastToAll, closeWebSocketsForCredential,
  credentialLockout, configManager,
  __dirname, DATA_DIR, SSH_PASSWORD, SSH_PORT, SSH_HOST: envConfig.sshHost, APP_VERSION, RP_NAME, PORT,
  getDraining: () => draining, getDaemonConnected: () => daemon.isConnected(),
  closeAllWebSockets,
  auth, csrf,
};

const routes = [
  ...createAuthRoutes(routeCtx),
  ...createAppRoutes(routeCtx),
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
  if (!isPublicPath(pathname) && !isLocalRequest(req) && !envConfig.noAuth) {
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
    // Re-validate session to close TOCTOU race between initial check and upgrade completion.
    // A credential/session could be revoked between the check above and this callback.
    if (sessionToken && !isLocalRequest(req)) {
      const freshState = loadState();
      if (!freshState || !freshState.isValidSession(sessionToken)) {
        log.warn("WebSocket rejected during upgrade: session invalidated", { ip: req.socket.remoteAddress });
        ws.close(1008, "Session invalidated");
        return;
      }
    }
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

// Close all WebSocket connections (used by revoke-all)
function closeAllWebSockets(code, reason) {
  for (const [clientId, info] of wsClients) {
    if (info.ws.readyState === 1) {
      info.ws.close(code, reason);
    }
    wsClients.delete(clientId);
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

    const wsMessageHandlers = {
      async attach() {
        const name = msg.session || "default";
        try {
          const result = await daemonRPC({ type: "attach", clientId, session: name, cols: msg.cols, rows: msg.rows });
          wsClients.set(clientId, {
            ws, session: name, sessionToken: ws.sessionToken,
            credentialId: ws.credentialId, p2pPeer: null, p2pConnected: false,
          });
          log.debug("Client attached", { clientId, session: name });
          ws.send(JSON.stringify({ type: "attached" }));
          if (result.buffer) ws.send(JSON.stringify({ type: "output", data: result.buffer }));
          if (!result.alive) ws.send(JSON.stringify({ type: "exit", code: -1 }));
        } catch (err) {
          log.error("Attach failed", { clientId, error: err.message });
          ws.send(JSON.stringify({ type: "error", message: "Daemon not available" }));
        }
      },
      input() {
        daemonSend({ type: "input", clientId, data: msg.data });
      },
      resize() {
        daemonSend({ type: "resize", clientId, cols: msg.cols, rows: msg.rows });
      },
      "p2p-signal"() {
        const info = wsClients.get(clientId);
        if (!info) return;
        if (!p2pAvailable) {
          ws.send(JSON.stringify({ type: "p2p-unavailable" }));
          return;
        }
        if (msg.data?.type === "offer" && info.p2pPeer) {
          destroyPeer(info.p2pPeer);
          info.p2pPeer = null;
          info.p2pConnected = false;
        }
        if (!info.p2pPeer) {
          info.p2pPeer = createServerPeer(
            (data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-signal", data })); },
            (chunk) => {
              try {
                const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
                const p2pMsg = JSON.parse(str);
                if (p2pMsg.type === "input") daemonSend({ type: "input", clientId, data: p2pMsg.data });
              } catch (err) { log.warn("Malformed P2P data", { clientId, error: err.message }); }
            },
            () => {
              const cur = wsClients.get(clientId);
              if (cur) { cur.p2pPeer = null; cur.p2pConnected = false; }
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-closed" }));
            }
          );
          info.p2pPeer.on("connect", () => {
            const cur = wsClients.get(clientId);
            if (cur) cur.p2pConnected = true;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "p2p-ready" }));
          });
        }
        info.p2pPeer.signal(msg.data);
      },
    };

    const handler = wsMessageHandlers[msg.type];
    if (handler) await handler();
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
if (envConfig.nodeEnv !== "production") {
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
  // Write PID file so CLI commands can find us
  try {
    writeFileSync(SERVER_PID_PATH, String(process.pid), { encoding: "utf-8" });
  } catch (err) {
    log.warn("Failed to write server PID file", { error: err.message });
  }
});

// --- Graceful shutdown ---

function cleanupPidFile() {
  try {
    // Only remove if it's our PID (another server may have overwritten it)
    if (existsSync(SERVER_PID_PATH)) {
      const content = readFileSync(SERVER_PID_PATH, "utf-8").trim();
      if (content === String(process.pid)) {
        unlinkSync(SERVER_PID_PATH);
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

let shutdownInProgress = false;

async function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  draining = true;

  log.info("Graceful shutdown starting", { signal, pid: process.pid });

  // 1. Notify all WebSocket clients that this server is draining
  //    (triggers fast reconnect on the frontend)
  for (const [, info] of wsClients) {
    if (info.ws.readyState === 1) {
      try {
        info.ws.send(JSON.stringify({ type: "server-draining" }));
      } catch { /* client may already be closing */ }
    }
  }

  // 2. Stop accepting new HTTP connections — releases the port immediately
  server.close(() => {
    log.info("HTTP server closed, no more new connections");
  });

  // 3. Wait briefly for clients to receive the draining message, then close WebSockets
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const [clientId, info] of wsClients) {
    if (info.ws.readyState === 1) {
      info.ws.close(1001, "Server shutting down"); // 1001 = Going Away
    }
    if (info.p2pPeer) {
      try { destroyPeer(info.p2pPeer); } catch { /* ignore */ }
    }
    wsClients.delete(clientId);
    daemonSend({ type: "detach", clientId });
  }

  // 4. Wait for WebSocket connections to drain (up to DRAIN_TIMEOUT_MS)
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // 5. Force-close any remaining connections
  for (const client of wss.clients) {
    client.terminate();
  }

  // 6. Disconnect from daemon (don't kill it — other servers may be connected)
  daemon.disconnect();

  // 7. Clean up PID file
  cleanupPidFile();

  log.info("Graceful shutdown complete", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

startSSHServer({
  port: SSH_PORT,
  hostKey: sshHostKey,
  password: SSH_PASSWORD,
  daemonRPC,
  daemonSend,
  credentialLockout,
  bridge,
});
