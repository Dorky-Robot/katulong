import { createServer } from "node:http";
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001", 10);
const SHELL = process.env.SHELL || "/bin/zsh";
const SHORTCUTS_PATH = join(__dirname, "shortcuts.json");

// --- Session management ---

// Map<string, { pty, outputBuffer: string[], clients: Set<ws>, alive: boolean }>
const sessions = new Map();
const MAX_BUFFER = 5000;

function createSession(name) {
  if (sessions.has(name)) return sessions.get(name);

  const p = pty.spawn(SHELL, ["-l"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const session = { pty: p, outputBuffer: [], clients: new Set(), alive: true };

  p.onData((data) => {
    session.outputBuffer.push(data);
    while (session.outputBuffer.length > MAX_BUFFER) session.outputBuffer.shift();
    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "output", data }));
      }
    }
  });

  p.onExit(({ exitCode }) => {
    console.log(`Session "${name}" exited (${exitCode})`);
    session.alive = false;
    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "exit", code: exitCode }));
      }
    }
  });

  sessions.set(name, session);
  console.log(`Session "${name}" created (pid ${p.pid})`);
  return session;
}

function removeSession(name) {
  const session = sessions.get(name);
  if (!session) return false;
  if (session.alive) {
    session.pty.kill();
  }
  for (const client of session.clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "session-removed" }));
    }
  }
  sessions.delete(name);
  console.log(`Session "${name}" removed`);
  return true;
}

function renameSession(oldName, newName) {
  const session = sessions.get(oldName);
  if (!session) return false;
  if (sessions.has(newName)) return false;
  sessions.delete(oldName);
  sessions.set(newName, session);
  // Notify clients of the rename
  for (const client of session.clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "session-renamed", name: newName }));
    }
  }
  console.log(`Session renamed: "${oldName}" -> "${newName}"`);
  return true;
}

function sessionList() {
  const list = [];
  for (const [name, s] of sessions) {
    list.push({ name, pid: s.pty.pid, alive: s.alive });
  }
  return list;
}

// --- HTTP server ---

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } else if (req.method === "GET" && path === "/shortcuts") {
    const data = readFileSync(SHORTCUTS_PATH, "utf-8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(data);
  } else if (req.method === "PUT" && path === "/shortcuts") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body);
      writeFileSync(SHORTCUTS_PATH, JSON.stringify(parsed, null, 2) + "\n");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  } else if (req.method === "GET" && path === "/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(sessionList()));
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
      if (sessions.has(safeName)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session already exists" }));
        return;
      }
      createSession(safeName);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: safeName }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  } else if (req.method === "DELETE" && path.startsWith("/sessions/")) {
    const name = decodeURIComponent(path.slice("/sessions/".length));
    if (removeSession(name)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
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
      if (renameSession(name, safeName)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: safeName }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found or name taken" }));
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
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

wss.on("connection", (ws) => {
  console.log("Client connected, waiting for attach");
  let attached = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "attach") {
      const name = msg.session || "default";
      const session = createSession(name); // lazy create
      session.clients.add(ws);
      attached = { name, session };
      console.log(`Client attached to "${name}"`);

      // Replay buffer
      if (session.outputBuffer.length > 0) {
        ws.send(JSON.stringify({ type: "output", data: session.outputBuffer.join("") }));
      }
      // Notify if already dead
      if (!session.alive) {
        ws.send(JSON.stringify({ type: "exit", code: -1 }));
      }
    } else if (msg.type === "input" && attached) {
      if (attached.session.alive) {
        attached.session.pty.write(msg.data);
      }
    } else if (msg.type === "resize" && attached) {
      if (attached.session.alive) {
        attached.session.pty.resize(msg.cols, msg.rows);
      }
    }
  });

  ws.on("close", () => {
    if (attached) {
      attached.session.clients.delete(ws);
      console.log(`Client detached from "${attached.name}"`);
    }
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
  console.log(`Katulong on http://0.0.0.0:${PORT}`);
});
