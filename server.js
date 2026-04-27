import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, watch, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import envConfig, { ensureDataDir } from "./lib/env-config.js";
import { log } from "./lib/log.js";

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
import { tmuxSocketArgs } from "./lib/tmux.js";
import { createMiddleware } from "./lib/routes/middleware.js";
import { createAuthRoutes } from "./lib/routes/auth-routes.js";
import { createAppRoutes } from "./lib/routes/app-routes.js";
import { createFileBrowserRoutes } from "./lib/file-browser.js";
import { createPortProxyRoutes, proxyWebSocket } from "./lib/port-proxy.js";
import { createWebSocketManager } from "./lib/ws-manager.js";
import { createTopicBroker } from "./lib/topic-broker.js";
import { createWatchlist } from "./lib/claude-watchlist.js";
import { createClaudeProcessor } from "./lib/claude-processor.js";
import { createOllamaClient } from "./lib/ollama-client.js";
import { createSessionSummarizer } from "./lib/session-summarizer.js";
import { createClaudeFeedRoutes } from "./lib/routes/claude-feed-routes.js";
import { createPermissionStore } from "./lib/claude-permissions.js";
import { readBody, parseJSON, json, setSecurityHeaders } from "./lib/request-util.js";
import { homedir } from "node:os";
import { loadPlugins } from "./lib/plugin-loader.js";
import { createUpgradeHandler } from "./lib/server-upgrade.js";
import { createServerShutdown } from "./lib/server-shutdown.js";

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
        execFile("tmux", [...tmuxSocketArgs(), "setenv", "-g", "DISPLAY", display], { timeout: 2000 }, () => {});
      }
    });
  } catch { /* no Xvfb — clipboard will use file-based fallback */ }
}

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
const SERVER_INFO_PATH = join(DATA_DIR, "server.json");
const DRAIN_TIMEOUT_MS = envConfig.drainTimeout;

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
  // ALSO require the Host header to be loopback. Tunnel traffic (Cloudflare,
  // ngrok) terminates at loopback too — without this check, a request with
  // a leaked KATULONG_TRUST_PROXY_SECRET could be routed through a tunnel
  // and bypass session auth from the public internet. The same lesson as
  // isLocalRequest() in lib/access-method.js: socket address alone is not
  // sufficient to classify a request as local.
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") {
    return false;
  }
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
  // API key auth via Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const apiKey = authHeader.slice(7);
    const state = loadState();
    if (state) {
      const keyData = state.findApiKey(apiKey);
      if (keyData) {
        req._apiKeyAuth = true;
        withStateLock((s) => {
          if (!s) return {};
          return { state: s.updateApiKeyActivity(keyData.id) };
        }).catch(() => {});
        return { authenticated: true, sessionToken: null, credentialId: null, apiKeyId: keyData.id };
      }
    }
    return null; // Invalid API key — don't fall through to cookie
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
  dataDir: DATA_DIR,
});
await sessionManager.restoreSessions();

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
const wsManager = createWebSocketManager({ bridge, sessionManager, pluginWsHandlers });
const { wsClients, broadcastToAll, closeAllWebSockets } = wsManager;

// --- Graceful shutdown (late-bound; created once `server` and `wss` exist below) ---
// `getDraining` needs a stable reference that routes can capture during
// `createAppRoutes` below, but the shutdown object itself depends on `server`
// and `wss` which don't exist yet. We assign after both are constructed, and
// the getter returns `false` in the brief window before shutdown is wired up
// (which, in practice, is only during module evaluation — never in a served
// request).
let shutdown = null;
const getDraining = () => shutdown?.isDraining() ?? false;

// Claude feed — opt-in narration of Claude Code sessions.
// The watchlist is the persistent ledger of UUIDs we've been asked to narrate.
// The processor auto-polls every watchlist entry from boot onward (slow when
// nobody is subscribed, fast when a feed tile is open). Refcount drives poll
// cadence, not worker existence — so a reconnecting subscriber sees the
// current transcript state instead of a cursor frozen at the last gap. See
// docs/claude-feed-watchlist.md for the full design.
const topicBroker = createTopicBroker();
const claudeWatchlist = createWatchlist({ dataDir: DATA_DIR });
const permissionStore = createPermissionStore();
// Pinned to the cloud model: local backbones (gemma3n:e2b,
// qwen2.5-coder:7b) were too resource-intensive on laptop-class hosts
// — the model swapped out between prompts and summaries stretched to
// minutes. The cloud offload is served through the same local Ollama
// daemon at http://127.0.0.1:11434 after `ollama signin`, so no
// additional config is needed beyond authenticating the daemon.
// Single shared client is intentional: we stay Claude-specific until
// a consumer actually needs a different model / timeout / host.
//
// resolveEndpoint reads the peer Ollama config on every request, so the
// Settings UI can swap endpoints without restarting the server. Returns
// null when no peer is configured — the client then falls back to the
// default localhost host.
const callOllama = createOllamaClient({
  model: "gemma4:31b-cloud",
  resolveEndpoint: () => {
    const peerUrl = configManager.getOllamaPeerUrl();
    if (!peerUrl) return null;
    return { host: peerUrl, authToken: configManager.getOllamaPeerToken() };
  },
});
const claudeProcessor = createClaudeProcessor({
  watchlist: claudeWatchlist,
  topicBroker,
  callOllama,
  // Mirror every summary onto the matching tmux session's
  // meta.claude.summary so the terminal-tab tooltip picks it up via
  // the normal session-updated broadcast channel. Kept outside the
  // processor so it doesn't depend on sessionManager directly.
  onSummary: (uuid, summary) => {
    const sessions = sessionManager.listSessions?.().sessions || [];
    const target = sessions.find((s) => s.meta?.claude?.uuid === uuid);
    if (!target) return;
    const live = sessionManager.getSession?.(target.name);
    const current = live?.meta?.claude || target.meta?.claude || {};
    live?.setMeta?.("claude", { ...current, summary });
  },
});

// Generic per-session summarizer — gives every tab a short auto-title
// and hover-tooltip based on recent terminal output. Independent of
// the Claude feed; works for any shell. Writes `meta.autoTitle` +
// `meta.summary`; the frontend prefers `meta.userTitle` when set.
const sessionSummarizer = createSessionSummarizer({
  sessionManager,
  callOllama,
});
sessionSummarizer.start();

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
    json, parseJSON, readBody, isAuthenticated, sessionManager,
    bridge,
    configManager,
    __dirname, DATA_DIR, APP_VERSION,
    getDraining,
    shortcutsPath: join(DATA_DIR, "shortcuts.json"),
    auth, csrf,
    topicBroker,
    permissionStore,
    getExternalUrl: () => configManager.getPublicUrl(),
  }),
  ...createClaudeFeedRoutes({
    json, parseJSON, auth, csrf,
    watchlist: claudeWatchlist,
    processor: claudeProcessor,
    topicBroker,
    sessionManager,
    permissionStore,
    homeDir: homedir(),
    log,
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

  // Auto-detect external URL from tunnel traffic and persist to config.
  // Only writes if publicUrl is not already set (user override wins).
  if (!isLocalRequest(req) && req.headers.host && !configManager.getPublicUrl()) {
    const proto = isHttpsConnection(req) ? "https" : "http";
    const detected = `${proto}://${req.headers.host}`;
    configManager.setPublicUrl(detected).catch(() => {});
  }

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

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", createUpgradeHandler({
  wss,
  isAuthenticated,
  isTrustedProxy,
  loadState,
  configManager,
  proxyWebSocket,
  wsManager,
}));

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

shutdown = createServerShutdown({
  server,
  wss,
  broadcastToAll,
  closeAllWebSockets,
  sessionManager,
  shutdownPlugins: async () => {
    sessionSummarizer.stop();
    await shutdownPlugins();
  },
  drainTimeoutMs: DRAIN_TIMEOUT_MS,
  pidPath: SERVER_PID_PATH,
  infoPath: SERVER_INFO_PATH,
});
shutdown.install();

