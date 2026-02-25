import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync, existsSync, watch, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import envConfig, { ensureDataDir } from "./lib/env-config.js";
import { log } from "./lib/log.js";
import { initP2P } from "./lib/p2p.js";
import {
  loadState, validateSession, refreshSessionActivity,
} from "./lib/auth.js";
import {
  parseCookies, isPublicPath, createChallengeStore,
} from "./lib/http-util.js";
import { rateLimit, getClientIp } from "./lib/rate-limit.js";
import { ConfigManager } from "./lib/config.js";
import { ensureHostKey, startSSHServer } from "./lib/ssh.js";
import { CredentialLockout } from "./lib/credential-lockout.js";
import { isLocalRequest } from "./lib/access-method.js";
import { serveStaticFile } from "./lib/static-files.js";
import { createTransportBridge } from "./lib/transport-bridge.js";
import { createDaemonClient } from "./lib/daemon-client.js";
import { createMiddleware, createAuthRoutes, createAppRoutes } from "./lib/routes.js";
import { createWebSocketManager } from "./lib/ws-manager.js";

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

const challengeStore = createChallengeStore(CHALLENGE_TTL_MS);
const { store: storeChallenge, consume: consumeChallenge } = challengeStore;

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

// --- WebSocket manager (extracted from inline code) ---
const wsManager = createWebSocketManager({ bridge, daemonRPC, daemonSend });
const { wsClients, broadcastToAll, closeAllWebSockets, closeWebSocketsForCredential } = wsManager;

// --- HTTP routes (assembled from lib/routes/) ---

const { auth, csrf } = createMiddleware({ isAuthenticated, json });

const routeCtx = {
  json, parseJSON, isAuthenticated, daemonRPC,
  storeChallenge, consumeChallenge, challengeStore,
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
    if (match.route.rateLimit) {
      const result = authRateLimit.check(req);
      if (result.exceeded) {
        json(res, 429, { error: "Too many requests", retryAfter: result.retryAfter });
        return;
      }
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

  if (!isAuthenticated(req)) {
    log.warn("WebSocket rejected: not authenticated", { ip: req.socket.remoteAddress });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

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
    if (sessionToken && !isLocalRequest(req)) {
      const freshState = loadState();
      if (!freshState || !freshState.isValidSession(sessionToken)) {
        log.warn("WebSocket rejected during upgrade: session invalidated", { ip: req.socket.remoteAddress });
        ws.close(1008, "Session invalidated");
        return;
      }
    }
    ws.sessionToken = sessionToken;
    ws.credentialId = credentialId;
    wss.emit("connection", ws, req);
  });
}

server.on("upgrade", handleUpgrade);

wss.on("connection", (ws) => wsManager.handleConnection(ws));

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
  broadcastToAll({ type: "server-draining" });

  // 2. Stop accepting new HTTP connections — releases the port immediately
  server.close(() => {
    log.info("HTTP server closed, no more new connections");
  });

  // 3. Wait briefly for clients to receive the draining message, then close WebSockets
  await new Promise((resolve) => setTimeout(resolve, 500));

  closeAllWebSockets(1001, "Server shutting down");

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
