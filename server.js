import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync, watch, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import envConfig, { ensureDataDir } from "./lib/env-config.js";
import { log } from "./lib/log.js";
import { initP2P } from "./lib/p2p.js";
import {
  loadState, validateSession, refreshSessionActivity, withStateLock,
} from "./lib/auth.js";
import {
  parseCookies, isPublicPath, createChallengeStore, isHttpsConnection,
} from "./lib/http-util.js";
import { rateLimit, getClientIp } from "./lib/rate-limit.js";
import { ConfigManager } from "./lib/config.js";

import { CredentialLockout } from "./lib/credential-lockout.js";
import { isLocalRequest, isLoopbackAddress } from "./lib/access-method.js";
import { serveStaticFile, clearFileCache, buildVendorHashes } from "./lib/static-files.js";
import { createTransportBridge } from "./lib/transport-bridge.js";
import { createSessionManager, checkTmux, cleanTmuxServerEnv, setTmuxKatulongEnv } from "./lib/session-manager.js";
import { createMiddleware, createAuthRoutes, createAppRoutes } from "./lib/routes.js";
import { createFileBrowserRoutes } from "./lib/file-browser.js";
import { createPortProxyRoutes, proxyWebSocket } from "./lib/port-proxy.js";
import { createWebSocketManager } from "./lib/ws-manager.js";
import { createHelmSessionManager } from "./lib/helm-session-manager.js";
import { readBody, parseJSON, json, setSecurityHeaders } from "./lib/request-util.js";
import { loadPlugins } from "./lib/plugin-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = envConfig.port;
const DATA_DIR = envConfig.dataDir;
ensureDataDir();

// Ensure uploads directory exists early so kubo containers can mount it.
// kubo only mounts ~/.katulong/uploads if the directory exists at container
// creation time — creating it on first upload is too late.
try { mkdirSync(join(DATA_DIR, "uploads"), { recursive: true }); } catch { /* ok */ }

// --- Configuration (load instance name first) ---

const configManager = new ConfigManager(DATA_DIR);
configManager.initialize();
const instanceName = configManager.getInstanceName();
const instanceId = configManager.getInstanceId();
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8")).version;
log.info("Configuration loaded", { instanceName, instanceId, version: APP_VERSION });

// Build vendor content hashes for automatic cache busting
buildVendorHashes(join(__dirname, "public"));

// Auto-detect Xvfb display on Linux (headless containers like kubo).
// Sets DISPLAY for this process and propagates it into tmux's global env
// so clipboard operations (xclip) work for both katulong and child processes.
if (process.platform === "linux" && !process.env.DISPLAY) {
  try {
    execFile("pgrep", ["-a", "Xvfb"], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return;
      const match = stdout.match(/:(\d+)/);
      if (match) {
        const display = `:${match[1]}`;
        process.env.DISPLAY = display;
        log.info("Auto-detected Xvfb display", { display });
        execFile("tmux", ["setenv", "-g", "DISPLAY", display], { timeout: 2000 }, () => {});
      }
    });
  } catch { /* no Xvfb — clipboard will use file-based fallback */ }
}

await initP2P();

const RP_NAME = "Katulong";

// --- Rate limiting ---
// 10 attempts per minute for auth endpoints
const authRateLimit = rateLimit(10, 60000, (req) => {
  const addr = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  const origin = req.headers['origin'] || req.headers['host'] || '';
  return `${addr}:${ua}:${origin}`;
});

// --- Constants ---

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

function isTrustedProxy(req) {
  const secret = envConfig.trustProxySecret;
  if (!secret) return false;
  // Only trust the header from loopback (proxy must run on the same machine)
  const addr = req.socket?.remoteAddress || "";
  if (!isLoopbackAddress(addr)) return false;
  const provided = req.headers["x-katulong-auth"];
  if (!provided || provided.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
  } catch {
    return false;
  }
}

/**
 * Check if a request is authenticated.
 * @returns {{ authenticated: boolean, sessionToken: string|null, credentialId: string|null } | null}
 *   Rich result object when authenticated, null when not.
 */
function isAuthenticated(req) {
  if (isTrustedProxy(req)) {
    log.debug("Auth bypassed: trusted proxy", { ip: req.socket.remoteAddress });
    return { authenticated: true, sessionToken: null, credentialId: null };
  }
  if (isLocalRequest(req)) {
    log.debug("Auth bypassed: localhost", { ip: req.socket.remoteAddress });
    return { authenticated: true, sessionToken: null, credentialId: null };
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.get("katulong_session");
  if (!token) {
    log.debug("Auth rejected: no token", { ip: req.socket.remoteAddress });
    return null;
  }
  const state = loadState();
  const valid = validateSession(state, token);
  log.debug("Auth check", {
    ip: req.socket.remoteAddress,
    hasState: state !== null,
    tokenPrefix: token.substring(0, 8) + "...",
    valid
  });
  if (!valid) return null;

  const session = state?.getLoginToken(token);
  return { authenticated: true, sessionToken: token, credentialId: session?.credentialId || null };
}

// --- Verify tmux is available ---

const hasTmux = await checkTmux();
if (!hasTmux) {
  log.error("tmux is required but not found. Install with: brew install tmux");
  process.exit(1);
}

// Strip SENSITIVE_ENV_VARS from the tmux server's global environment
// so they don't leak into terminal sessions (defense-in-depth).
await cleanTmuxServerEnv();
await setTmuxKatulongEnv(join(__dirname, "bin"), PORT);

// --- Session manager (replaces daemon IPC) ---

const bridge = createTransportBridge();
const sessionManager = createSessionManager({
  bridge,
  shell: envConfig.shell,
  home: envConfig.home,
});

// --- Periodic expired session pruning (1 hour) ---
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneTimer = setInterval(async () => {
  try {
    await withStateLock((state) => {
      if (!state) return {};
      const pruned = state.pruneExpired();
      if (pruned.loginTokenCount() < state.loginTokenCount()) {
        log.info("Pruned expired login tokens", {
          removed: state.loginTokenCount() - pruned.loginTokenCount(),
        });
        return { state: pruned };
      }
      return {};
    });
  } catch (err) {
    log.warn("Login token pruning failed", { error: err.message });
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

// --- Helm session manager (agentic browser mode) ---
const helmSessionManager = createHelmSessionManager({ bridge });

// --- HTTP routes (assembled from lib/routes/) ---

const { auth, csrf } = createMiddleware({ isAuthenticated, json });

// --- Plugins ---
const { pluginRoutes, pluginWsHandlers, shutdownPlugins } = await loadPlugins({
  dataDir: DATA_DIR,
  rootDir: __dirname,
  auth, csrf, json, parseJSON, bridge,
  broadcastToAll: (payload) => wsManager.broadcastToAll(payload),
  log,
});

// --- WebSocket manager ---
const wsManager = createWebSocketManager({ bridge, sessionManager, helmSessionManager, pluginWsHandlers });
const { wsClients, broadcastToAll, closeAllWebSockets } = wsManager;

const routes = [
  ...createAuthRoutes({
    json, parseJSON, isAuthenticated,
    storeChallenge, consumeChallenge, challengeStore,
    bridge,
    credentialLockout,
    RP_NAME, PORT,
    auth, csrf,
  }),
  ...createAppRoutes({
    json, parseJSON, isAuthenticated, sessionManager,
    helmSessionManager, bridge,
    configManager,
    __dirname, DATA_DIR, APP_VERSION,
    getDraining: () => draining,
    shortcutsPath: join(DATA_DIR, "shortcuts.json"),
    auth, csrf,
  }),
  ...createFileBrowserRoutes({ json, parseJSON, auth, csrf }),
  ...createPortProxyRoutes({ auth, PORT, configManager }),
  ...pluginRoutes,
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
  // HSTS: instruct browsers to always use HTTPS for this domain
  if (isHttpsConnection(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Auth middleware: redirect unauthenticated requests
  if (!isPublicPath(pathname) && !isAuthenticated(req)) {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  // Refresh session activity for authenticated requests (sliding expiry)
  // Skip for localhost (auto-authenticated) and public paths
  if (!isPublicPath(pathname) && !isLocalRequest(req)) {
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
        res.setHeader("Retry-After", String(result.retryAfter));
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

function rejectUpgrade(socket, status) {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

function authenticateUpgrade(req) {
  const auth = isAuthenticated(req);
  if (!auth) return null;
  return { sessionToken: auth.sessionToken, credentialId: auth.credentialId };
}

function validateUpgradeOrigin(req) {
  if (isTrustedProxy(req)) return true;
  if (isLocalRequest(req)) return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function handleUpgrade(req, socket, head) {
  log.info("WebSocket upgrade attempt", {
    ip: req.socket.remoteAddress,
    origin: req.headers.origin,
    host: req.headers.host
  });

  const auth = authenticateUpgrade(req);
  if (!auth) {
    log.warn("WebSocket rejected: not authenticated", { ip: req.socket.remoteAddress });
    return rejectUpgrade(socket, "401 Unauthorized");
  }

  if (!validateUpgradeOrigin(req)) {
    log.warn("WebSocket rejected: origin validation failed", { origin: req.headers.origin, host: req.headers.host });
    return rejectUpgrade(socket, "403 Forbidden");
  }

  const { pathname: wsPathname } = new URL(req.url, `http://${req.headers.host}`);

  // Claude session WebSocket — yolo processes connect here
  if (wsPathname === "/ws/helm") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      helmSessionManager.handleConnection(ws);
    });
    return;
  }

  // Port proxy WebSocket — intercept before terminal WS handling
  if (wsPathname.startsWith("/_proxy/")) {
    if (configManager.getPortProxyEnabled() === false) {
      return rejectUpgrade(socket, "403 Forbidden");
    }
    proxyWebSocket(req, socket, head, wsPathname);
    return;
  }

  const { sessionToken, credentialId } = auth;
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (sessionToken && !isLocalRequest(req)) {
      const freshState = loadState();
      if (!freshState || !freshState.isValidLoginToken(sessionToken)) {
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
    clearFileCache();
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify({ type: "reload" }));
    }
  });
  watcher.on("error", (err) => {
    log.warn("Live-reload watcher error", { error: err.message });
  });
}

process.on("unhandledRejection", (err) => {
  log.error("Unhandled rejection — crashing to allow clean restart", { error: err?.message || String(err), stack: err?.stack });
  process.exit(1);
});

const SERVER_INFO_PATH = join(DATA_DIR, "server.json");

server.listen(PORT, envConfig.bindHost, () => {
  log.info("Katulong HTTP started", { port: PORT, host: envConfig.bindHost });
  // Write PID file so CLI commands can find us
  try {
    writeFileSync(SERVER_PID_PATH, String(process.pid), { encoding: "utf-8" });
  } catch (err) {
    log.warn("Failed to write server PID file", { error: err.message });
  }
  // Write server info so tools (yolo) can discover us without env vars
  try {
    writeFileSync(SERVER_INFO_PATH, JSON.stringify({
      pid: process.pid,
      port: PORT,
      host: envConfig.bindHost,
    }), { encoding: "utf-8" });
  } catch (err) {
    log.warn("Failed to write server info file", { error: err.message });
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
  try {
    if (existsSync(SERVER_INFO_PATH)) {
      const info = JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));
      if (info.pid === process.pid) {
        unlinkSync(SERVER_INFO_PATH);
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

  // 6. Shutdown session manager (close control mode procs, leave tmux sessions alive)
  sessionManager.shutdown();
  helmSessionManager.shutdown();

  // 7. Shutdown plugins
  await shutdownPlugins();

  // 8. Clean up PID file
  cleanupPidFile();

  log.info("Graceful shutdown complete", { signal });
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

