import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFileSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { encode, decoder } from "./lib/ndjson.js";
import { log } from "./lib/log.js";
import {
  loadState, saveState, isSetup,
  generateRegistrationOpts, verifyRegistration,
  generateAuthOpts, verifyAuth,
  createSession, validateSession, pruneExpiredSessions,
} from "./lib/auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";

const SETUP_TOKEN = process.env.SETUP_TOKEN || randomBytes(16).toString("hex");
const RP_NAME = "Katulong";

if (!process.env.SETUP_TOKEN) {
  log.info("Setup token generated", { token: SETUP_TOKEN });
}

// --- Challenge storage (in-memory, 5-min expiry) ---

const challenges = new Map(); // challenge -> expiry timestamp
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function storeChallenge(challenge) {
  challenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
}

function consumeChallenge(challenge) {
  const expiry = challenges.get(challenge);
  if (!expiry) return false;
  challenges.delete(challenge);
  // Prune expired challenges while we're here (skip metadata keys)
  const now = Date.now();
  for (const [c, exp] of challenges) {
    if (typeof exp === "number" && now >= exp) challenges.delete(c);
  }
  return now < expiry;
}

// --- Cookie helpers ---

function parseCookies(header) {
  const map = new Map();
  if (!header) return map;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return map;
}

function setSessionCookie(res, token, expiry) {
  const maxAge = Math.floor((expiry - Date.now()) / 1000);
  const existing = res.getHeader("Set-Cookie") || [];
  const cookies = Array.isArray(existing) ? existing : [existing].filter(Boolean);
  cookies.push(`katulong_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
  res.setHeader("Set-Cookie", cookies);
}

// --- Auth helpers ---

function getOriginAndRpID(req) {
  const host = req.headers.host || "localhost";
  const hostname = host.split(":")[0];
  const proto = req.headers["x-forwarded-proto"] || "http";
  const origin = `${proto}://${host}`;
  return { origin, rpID: hostname };
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.get("katulong_session");
  if (!token) return false;
  const state = loadState();
  return validateSession(state, token);
}

const STATIC_EXTS = new Set([".js", ".css", ".png", ".ico", ".webp", ".svg", ".woff2", ".json"]);

function isPublicPath(pathname) {
  if (pathname === "/login" || pathname === "/login.html") return true;
  if (pathname.startsWith("/auth/")) return true;
  // Allow static assets through (fonts, icons, etc.)
  const ext = extname(pathname);
  if (ext && STATIC_EXTS.has(ext) && pathname !== "/") return true;
  return false;
}

// --- IPC client to daemon ---

let daemonSocket = null;
let daemonConnected = false;
const pendingRPC = new Map();

function connectDaemon() {
  if (daemonSocket) {
    daemonSocket.removeAllListeners();
    daemonSocket.destroy();
  }

  daemonSocket = createConnection(SOCKET_PATH);

  daemonSocket.on("connect", () => {
    daemonConnected = true;
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
    log.warn("Disconnected from daemon, reconnecting in 1s");
    for (const [, { reject, timer }] of pendingRPC) {
      clearTimeout(timer);
      reject(new Error("Daemon disconnected"));
    }
    pendingRPC.clear();
    setTimeout(connectDaemon, 1000);
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

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sanitizeName(raw) {
  if (!raw || typeof raw !== "string") return null;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return safe || null;
}

async function parseJSON(req) {
  const body = await readBody(req);
  return JSON.parse(body);
}

// --- HTTP routes ---

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

const routes = [
  { method: "GET", path: "/", handler: (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "public", "index.html"), "utf-8"));
  }},

  { method: "GET", path: "/login", handler: (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "public", "login.html"), "utf-8"));
  }},

  // --- Auth routes ---

  { method: "GET", path: "/auth/status", handler: (req, res) => {
    json(res, 200, { setup: isSetup() });
  }},

  { method: "POST", path: "/auth/register/options", handler: async (req, res) => {
    const { setupToken } = await parseJSON(req);
    if (setupToken !== SETUP_TOKEN) {
      return json(res, 403, { error: "Invalid setup token" });
    }
    if (isSetup()) {
      return json(res, 409, { error: "Already set up" });
    }
    const { origin, rpID } = getOriginAndRpID(req);
    const { opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, origin);
    storeChallenge(opts.challenge);
    // Store userID temporarily with the challenge for use during verification
    challenges.set(`userID:${opts.challenge}`, userID);
    json(res, 200, opts);
  }},

  { method: "POST", path: "/auth/register/verify", handler: async (req, res) => {
    const { credential, setupToken } = await parseJSON(req);
    if (setupToken !== SETUP_TOKEN) {
      return json(res, 403, { error: "Invalid setup token" });
    }
    if (isSetup()) {
      return json(res, 409, { error: "Already set up" });
    }
    const { origin, rpID } = getOriginAndRpID(req);

    // Extract challenge from clientDataJSON
    const clientData = JSON.parse(
      Buffer.from(credential.response.clientDataJSON, "base64url").toString()
    );
    const challenge = clientData.challenge;
    if (!consumeChallenge(challenge)) {
      return json(res, 400, { error: "Challenge expired or invalid" });
    }
    const userID = challenges.get(`userID:${challenge}`);
    challenges.delete(`userID:${challenge}`);

    try {
      const cred = await verifyRegistration(credential, challenge, origin, rpID);
      const session = createSession();
      const state = {
        user: { id: userID, name: "owner" },
        credentials: [cred],
        sessions: { [session.token]: session.expiry },
      };
      saveState(state);
      setSessionCookie(res, session.token, session.expiry);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
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
    const { credential } = await parseJSON(req);
    let state = loadState();
    if (!state) {
      return json(res, 400, { error: "Not set up yet" });
    }
    const { origin, rpID } = getOriginAndRpID(req);

    // Find matching credential
    const storedCred = state.credentials.find((c) => c.id === credential.id);
    if (!storedCred) {
      return json(res, 400, { error: "Unknown credential" });
    }

    // Extract and consume challenge from clientDataJSON
    const clientData = JSON.parse(
      Buffer.from(credential.response.clientDataJSON, "base64url").toString()
    );
    const challenge = clientData.challenge;
    if (!consumeChallenge(challenge)) {
      return json(res, 400, { error: "Challenge expired or invalid" });
    }

    try {
      const newCounter = await verifyAuth(credential, storedCred, challenge, origin, rpID);
      storedCred.counter = newCounter;
      state = pruneExpiredSessions(state);
      const session = createSession();
      state.sessions[session.token] = session.expiry;
      saveState(state);
      setSessionCookie(res, session.token, session.expiry);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  }},

  // --- App routes ---

  { method: "GET", path: "/shortcuts", handler: async (req, res) => {
    const result = await daemonRPC({ type: "get-shortcuts" });
    json(res, 200, result.shortcuts);
  }},

  { method: "PUT", path: "/shortcuts", handler: async (req, res) => {
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
    const safeName = sanitizeName(name);
    if (!safeName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "create-session", name: safeName });
    json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
  }},

  { method: "DELETE", prefix: "/sessions/", handler: async (req, res, name) => {
    const result = await daemonRPC({ type: "delete-session", name });
    json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true });
  }},

  { method: "PUT", prefix: "/sessions/", handler: async (req, res, name) => {
    const { name: newName } = await parseJSON(req);
    const safeName = sanitizeName(newName);
    if (!safeName) return json(res, 400, { error: "Invalid name" });
    const result = await daemonRPC({ type: "rename-session", oldName: name, newName: safeName });
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

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Auth middleware: redirect unauthenticated requests to /login
  if (!isPublicPath(pathname) && !isAuthenticated(req)) {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  const match = matchRoute(req.method, pathname);

  if (match) {
    try {
      await match.route.handler(req, res, match.param);
    } catch (err) {
      if (err instanceof SyntaxError) {
        json(res, 400, { error: "Invalid JSON" });
      } else {
        const status = err.message === "Daemon not connected" ? 503 : 500;
        json(res, status, { error: err.message });
      }
    }
    return;
  }

  // Static files
  const filePath = join(__dirname, "public", pathname);
  if (req.method === "GET" && existsSync(filePath)) {
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// --- WebSocket ---

const wss = new WebSocketServer({ noServer: true });
const wsClients = new Map(); // clientId -> { ws, session }

server.on("upgrade", (req, socket, head) => {
  // Validate session cookie on WebSocket upgrade
  if (!isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Relay daemon broadcasts to matching browser clients
function sendToSession(sessionName, payload) {
  for (const [, info] of wsClients) {
    if (info.session === sessionName && info.ws.readyState === 1) {
      info.ws.send(JSON.stringify(payload));
    }
  }
}

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
}

wss.on("connection", (ws) => {
  const clientId = randomUUID();
  log.debug("Client connected", { clientId });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "attach") {
      const name = msg.session || "default";
      try {
        const result = await daemonRPC({ type: "attach", clientId, session: name });
        wsClients.set(clientId, { ws, session: name });
        log.debug("Client attached", { clientId, session: name });
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
    }
  });

  ws.on("close", () => {
    log.debug("Client disconnected", { clientId });
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

server.listen(PORT, "0.0.0.0", () => {
  log.info("Katulong UI started", { port: PORT });
});
