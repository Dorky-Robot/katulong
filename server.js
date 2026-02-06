import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFileSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { encode, decoder } from "./lib/ndjson.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";

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
    console.log("Connected to daemon");
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
    console.log("Disconnected from daemon, reconnecting in 1s...");
    for (const [, { reject, timer }] of pendingRPC) {
      clearTimeout(timer);
      reject(new Error("Daemon disconnected"));
    }
    pendingRPC.clear();
    setTimeout(connectDaemon, 1000);
  });

  daemonSocket.on("error", (err) => {
    if (err.code !== "ENOENT" && err.code !== "ECONNREFUSED") {
      console.error("Daemon socket error:", err.message);
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

const wss = new WebSocketServer({ server });
const wsClients = new Map(); // clientId -> { ws, session }

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
  console.log(`Client connected (${clientId})`);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "attach") {
      const name = msg.session || "default";
      try {
        const result = await daemonRPC({ type: "attach", clientId, session: name });
        wsClients.set(clientId, { ws, session: name });
        console.log(`Client ${clientId} attached to "${name}"`);
        if (result.buffer) ws.send(JSON.stringify({ type: "output", data: result.buffer }));
        if (!result.alive) ws.send(JSON.stringify({ type: "exit", code: -1 }));
      } catch (err) {
        console.error(`Attach failed for ${clientId}:`, err.message);
        ws.send(JSON.stringify({ type: "error", message: "Daemon not available" }));
      }
    } else if (msg.type === "input") {
      daemonSend({ type: "input", clientId, data: msg.data });
    } else if (msg.type === "resize") {
      daemonSend({ type: "resize", clientId, cols: msg.cols, rows: msg.rows });
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected (${clientId})`);
    wsClients.delete(clientId);
    daemonSend({ type: "detach", clientId });
  });
});

// Live-reload
watch(join(__dirname, "public"), { recursive: true }, () => {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(JSON.stringify({ type: "reload" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Katulong UI on http://0.0.0.0:${PORT}`);
});
