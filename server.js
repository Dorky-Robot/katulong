import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readFileSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";

// --- IPC client to daemon ---

let daemonSocket = null;
let daemonConnected = false;
let ipcBuffer = "";
const pendingRPC = new Map(); // id -> { resolve, reject, timer }

// Callbacks for broadcast messages from daemon
const broadcastHandlers = [];

function connectDaemon() {
  if (daemonSocket) {
    daemonSocket.removeAllListeners();
    daemonSocket.destroy();
  }

  daemonSocket = createConnection(SOCKET_PATH);

  daemonSocket.on("connect", () => {
    daemonConnected = true;
    ipcBuffer = "";
    console.log("Connected to daemon");
  });

  daemonSocket.on("data", (chunk) => {
    ipcBuffer += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = ipcBuffer.indexOf("\n")) !== -1) {
      const line = ipcBuffer.slice(0, newlineIdx);
      ipcBuffer = ipcBuffer.slice(newlineIdx + 1);
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          if (msg.id && pendingRPC.has(msg.id)) {
            const { resolve, timer } = pendingRPC.get(msg.id);
            clearTimeout(timer);
            pendingRPC.delete(msg.id);
            resolve(msg);
          } else {
            // Broadcast message from daemon
            for (const handler of broadcastHandlers) {
              handler(msg);
            }
          }
        } catch (e) {
          console.error("Bad IPC message:", e.message);
        }
      }
    }
  });

  daemonSocket.on("close", () => {
    daemonConnected = false;
    console.log("Disconnected from daemon, reconnecting in 1s...");
    // Reject all pending RPCs
    for (const [id, { reject, timer }] of pendingRPC) {
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
    if (!daemonConnected) {
      reject(new Error("Daemon not connected"));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRPC.delete(id);
      reject(new Error("RPC timeout"));
    }, timeoutMs);
    pendingRPC.set(id, { resolve, reject, timer });
    daemonSocket.write(JSON.stringify({ id, ...msg }) + "\n");
  });
}

function daemonSend(msg) {
  if (daemonConnected) {
    daemonSocket.write(JSON.stringify(msg) + "\n");
  }
}

connectDaemon();

// --- HTTP server ---

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function daemonError(res, err) {
  const status = err.message === "Daemon not connected" ? 503 : 500;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err.message }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } else if (req.method === "GET" && path === "/shortcuts") {
    try {
      const result = await daemonRPC({ type: "get-shortcuts" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.shortcuts));
    } catch (err) {
      daemonError(res, err);
    }
  } else if (req.method === "PUT" && path === "/shortcuts") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      const result = await daemonRPC({ type: "set-shortcuts", data: parsed });
      if (result.error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      } else {
        daemonError(res, err);
      }
    }
  } else if (req.method === "GET" && path === "/sessions") {
    try {
      const result = await daemonRPC({ type: "list-sessions" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.sessions));
    } catch (err) {
      daemonError(res, err);
    }
  } else if (req.method === "POST" && path === "/sessions") {
    const body = await readBody(req);
    try {
      const { name } = JSON.parse(body);
      if (!name || typeof name !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "name required" }));
        return;
      }
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      if (!safeName) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid name" }));
        return;
      }
      const result = await daemonRPC({ type: "create-session", name: safeName });
      if (result.error) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: result.name }));
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      } else {
        daemonError(res, err);
      }
    }
  } else if (req.method === "DELETE" && path.startsWith("/sessions/")) {
    const name = decodeURIComponent(path.slice("/sessions/".length));
    try {
      const result = await daemonRPC({ type: "delete-session", name });
      if (result.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    } catch (err) {
      daemonError(res, err);
    }
  } else if (req.method === "PUT" && path.startsWith("/sessions/")) {
    const name = decodeURIComponent(path.slice("/sessions/".length));
    const body = await readBody(req);
    try {
      const { name: newName } = JSON.parse(body);
      if (!newName || typeof newName !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "name required" }));
        return;
      }
      const safeName = newName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      if (!safeName) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid name" }));
        return;
      }
      const result = await daemonRPC({ type: "rename-session", oldName: name, newName: safeName });
      if (result.error) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: result.name }));
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      } else {
        daemonError(res, err);
      }
    }
  } else {
    // Static file serving from public/
    const MIME = {
      ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
      ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
      ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2",
    };
    const filePath = join(__dirname, "public", path);
    if (req.method === "GET" && existsSync(filePath)) {
      const ext = extname(filePath);
      const contentType = MIME[ext] || "application/octet-stream";
      const data = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }
});

// --- WebSocket ---

const wss = new WebSocketServer({ server });

// Track browser clients: clientId -> { ws, session }
const wsClients = new Map();

// Handle broadcast messages from daemon
broadcastHandlers.push((msg) => {
  if (msg.type === "output") {
    for (const [clientId, info] of wsClients) {
      if (info.session === msg.session && info.ws.readyState === 1) {
        info.ws.send(JSON.stringify({ type: "output", data: msg.data }));
      }
    }
  } else if (msg.type === "exit") {
    for (const [clientId, info] of wsClients) {
      if (info.session === msg.session && info.ws.readyState === 1) {
        info.ws.send(JSON.stringify({ type: "exit", code: msg.code }));
      }
    }
  } else if (msg.type === "session-removed") {
    for (const [clientId, info] of wsClients) {
      if (info.session === msg.session && info.ws.readyState === 1) {
        info.ws.send(JSON.stringify({ type: "session-removed" }));
      }
    }
  } else if (msg.type === "session-renamed") {
    for (const [clientId, info] of wsClients) {
      if (info.session === msg.session && info.ws.readyState === 1) {
        info.ws.send(JSON.stringify({ type: "session-renamed", name: msg.newName }));
        info.session = msg.newName;
      }
    }
  }
});

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
        // Replay buffer
        if (result.buffer) {
          ws.send(JSON.stringify({ type: "output", data: result.buffer }));
        }
        // Notify if already dead
        if (!result.alive) {
          ws.send(JSON.stringify({ type: "exit", code: -1 }));
        }
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

// Live-reload: watch public/ and notify all browsers
watch(join(__dirname, "public"), { recursive: true }, () => {
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "reload" }));
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Katulong UI on http://0.0.0.0:${PORT}`);
});
