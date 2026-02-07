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
} from "./lib/auth.js";
import {
  parseCookies, setSessionCookie, getOriginAndRpID,
  isPublicPath, sanitizeName, createChallengeStore, escapeAttr,
} from "./lib/http-util.js";
import { ensureCerts, generateMobileConfig } from "./lib/tls.js";
import { ensureHostKey, startSSHServer } from "./lib/ssh.js";
import mdns from "multicast-dns";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || "3002", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const DATA_DIR = process.env.KATULONG_DATA_DIR || __dirname;
const SSH_PORT = parseInt(process.env.SSH_PORT || "2222", 10);
const SSH_PASSWORD = process.env.SSH_PASSWORD || null; // falls back to SETUP_TOKEN

// --- TLS certificates (auto-generated) ---

const tlsPaths = ensureCerts(DATA_DIR, "Katulong");
log.info("TLS certificates ready", { dir: join(DATA_DIR, "tls") });

const sshHostKey = ensureHostKey(DATA_DIR);

const SETUP_TOKEN = process.env.SETUP_TOKEN || randomBytes(16).toString("hex");
const RP_NAME = "Katulong";

if (!process.env.SETUP_TOKEN) {
  log.info("Setup token generated", { token: SETUP_TOKEN });
}

if (process.env.KATULONG_NO_AUTH === "1") {
  log.warn("WARNING: KATULONG_NO_AUTH=1 — authentication is DISABLED. All requests are treated as authenticated. Do NOT use this in production or on untrusted networks.");
}

// --- Challenge storage (in-memory, 5-min expiry) ---

const { store: storeChallenge, consume: consumeChallenge, _challenges: challenges } = createChallengeStore(5 * 60 * 1000);

// --- Device pairing (in-memory, 30s expiry) ---

const pairingChallenges = new Map();
const PAIR_TTL_MS = 30 * 1000;

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
  // Only loopback — LAN is untrusted (public WiFi, etc.)
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isAuthenticated(req) {
  if (process.env.KATULONG_NO_AUTH === "1") return true;
  if (isLocalRequest(req)) return true;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.get("katulong_session");
  if (!token) return false;
  const state = loadState();
  return validateSession(state, token);
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
let daemonReconnectDelay = 1000;
const pendingRPC = new Map();

function connectDaemon() {
  if (daemonSocket) {
    daemonSocket.removeAllListeners();
    daemonSocket.destroy();
  }

  daemonSocket = createConnection(SOCKET_PATH);

  daemonSocket.on("connect", () => {
    daemonConnected = true;
    daemonReconnectDelay = 1000;
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
    daemonReconnectDelay = Math.min(daemonReconnectDelay * 2, 30000);
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

function readBody(req, maxSize = 1024 * 1024) {
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

async function parseJSON(req, maxSize = 1024 * 1024) {
  const body = await readBody(req, maxSize);
  return JSON.parse(body);
}

// --- HTTP routes ---

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

function isLanHost(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host);
}

const routes = [
  { method: "GET", path: "/", handler: (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "public", "index.html"), "utf-8"));
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
    res.writeHead(200, { "Content-Type": "text/html" });
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
    const { credential, setupToken } = await parseJSON(req);
    if (setupToken !== SETUP_TOKEN) {
      return json(res, 403, { error: "Invalid setup token" });
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
      if (isSetup()) {
        // Append credential to existing state
        let state = loadState();
        state = pruneExpiredSessions(state);
        state.credentials.push(cred);
        state.sessions[session.token] = session.expiry;
        saveState(state);
      } else {
        // First device: create new state
        const state = {
          user: { id: userID, name: "owner" },
          credentials: [cred],
          sessions: { [session.token]: session.expiry },
        };
        saveState(state);
      }
      setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });
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
      setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  }},

  // --- Pairing routes ---

  { method: "POST", path: "/auth/pair/start", handler: (req, res) => {
    // Only authenticated users (e.g. localhost auto-auth) can start pairing
    if (!isAuthenticated(req)) {
      return json(res, 401, { error: "Authentication required" });
    }
    const code = randomUUID();
    const pin = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
    const expiresAt = Date.now() + PAIR_TTL_MS;
    pairingChallenges.set(code, { pin, expiresAt });
    // Sweep expired entries
    for (const [c, v] of pairingChallenges) {
      if (Date.now() >= v.expiresAt) pairingChallenges.delete(c);
    }
    const lanIP = getLanIP();
    const url = lanIP ? `https://${lanIP}:${HTTPS_PORT}/pair?code=${code}` : null;
    json(res, 200, { code, pin, url, expiresAt });
  }},

  { method: "POST", path: "/auth/pair/verify", handler: async (req, res) => {
    const { code, pin } = await parseJSON(req);

    // Validate input presence
    if (!code || !pin) {
      return json(res, 400, { error: "Missing code or PIN" });
    }

    // Validate code format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(String(code))) {
      return json(res, 400, { error: "Invalid code format" });
    }

    const challenge = pairingChallenges.get(code);
    if (!challenge) {
      log.warn("Pair verify: code not found", { code, mapSize: pairingChallenges.size });
      return json(res, 400, { error: "Invalid or expired pairing code" });
    }
    if (Date.now() >= challenge.expiresAt) {
      pairingChallenges.delete(code);
      return json(res, 400, { error: "Pairing code expired" });
    }
    // Normalize: strip anything that isn't a digit
    const submittedPin = String(pin).replace(/\D/g, "");

    // Validate PIN format (exactly 6 digits)
    if (submittedPin.length !== 6 || !/^\d{6}$/.test(submittedPin)) {
      pairingChallenges.delete(code); // single-attempt: prevent brute-force within TTL
      log.warn("Pair verify: invalid PIN format", { code, pinLength: submittedPin.length });
      return json(res, 400, { error: "PIN must be exactly 6 digits" });
    }

    if (challenge.pin !== submittedPin) {
      pairingChallenges.delete(code); // single-attempt: prevent brute-force within TTL
      log.warn("Pair verify: PIN mismatch", { code });
      return json(res, 403, { error: "Invalid PIN" });
    }
    pairingChallenges.delete(code);
    let state = loadState();
    if (!state) {
      state = { user: { id: "paired-user", name: "owner" }, credentials: [], sessions: {} };
    }
    state = pruneExpiredSessions(state);
    const session = createSession();
    state.sessions[session.token] = session.expiry;
    saveState(state);
    setSessionCookie(res, session.token, session.expiry, { secure: !!req.socket.encrypted });
    // Notify all connected WS clients so the pairing modal auto-dismisses
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "pair-complete", code }));
      }
    }
    json(res, 200, { ok: true });
  }},

  { method: "GET", path: "/pair", handler: (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "public", "pair.html"), "utf-8"));
  }},

  // --- Trust / certificate routes ---

  { method: "GET", path: "/connect/trust", handler: (req, res) => {
    const lanIP = getLanIP();
    const targetUrl = lanIP ? `https://katulong.local` : `https://localhost:${HTTPS_PORT}`;
    let html = readFileSync(join(__dirname, "public", "trust.html"), "utf-8");
    html = html.replace("<body>", `<body data-https-url="${escapeAttr(targetUrl)}" data-lan-ip="${escapeAttr(lanIP || "")}" data-https-port="${escapeAttr(HTTPS_PORT)}">`);

    res.writeHead(200, { "Content-Type": "text/html" });
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
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }},

  { method: "POST", path: "/auth/logout", handler: (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.get("katulong_session");
    if (token) {
      const state = loadState();
      if (state?.sessions?.[token]) {
        delete state.sessions[token];
        saveState(state);
      }
    }
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
  }},

  { method: "POST", path: "/auth/revoke-all", handler: (req, res) => {
    const state = loadState();
    if (!state) return json(res, 400, { error: "Not set up" });
    revokeAllSessions(state);
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (req.socket.encrypted) clearCookie += "; Secure";
    res.setHeader("Set-Cookie", clearCookie);
    json(res, 200, { ok: true });
  }},

  // --- Upload route ---

  { method: "POST", path: "/upload", handler: async (req, res) => {
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
    json(res, 200, { password: SSH_PASSWORD || SETUP_TOKEN });
  }},

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

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

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
      // No valid session → show cert installation page
      res.writeHead(302, { Location: "/connect/trust" });
      res.end();
      return;
    }
  }

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
      } else if (err.message === "Request body too large") {
        json(res, 413, { error: "Request body too large" });
      } else {
        const status = err.message === "Daemon not connected" ? 503 : 500;
        json(res, status, { error: err.message });
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
  // Validate session cookie on WebSocket upgrade
  if (!isAuthenticated(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

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
  password: SSH_PASSWORD || SETUP_TOKEN,
  daemonRPC,
  daemonSend,
});
