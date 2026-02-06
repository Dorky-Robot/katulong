import { createServer, createConnection } from "node:net";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pty from "node-pty";
import { encode, decoder } from "./lib/ndjson.js";
import { log } from "./lib/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const SHELL = process.env.SHELL || "/bin/zsh";
const DATA_DIR = process.env.KATULONG_DATA_DIR || __dirname;
const SHORTCUTS_PATH = join(DATA_DIR, "shortcuts.json");
const MAX_BUFFER = 5000;
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB

// --- State (boundary) ---

const sessions = new Map();
const clients = new Map();   // clientId -> { session: string, socket }
const uiSockets = new Set();

// --- Pure-ish helpers ---

function sessionList() {
  return [...sessions].map(([name, s]) => ({
    name, pid: s.pty.pid, alive: s.alive,
  }));
}

function aliveSessionFor(clientId) {
  const info = clients.get(clientId);
  if (!info) return null;
  const session = sessions.get(info.session);
  return session?.alive ? session : null;
}

// --- Side-effectful session operations ---

function broadcast(msg) {
  const line = encode(msg);
  for (const sock of uiSockets) sock.write(line);
}

function spawnSession(name, cols = 120, rows = 40) {
  const p = pty.spawn(SHELL, ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const session = { pty: p, outputBuffer: [], bufferBytes: 0, alive: true };

  p.onData((data) => {
    session.outputBuffer.push(data);
    session.bufferBytes += data.length;
    while (session.outputBuffer.length > MAX_BUFFER || session.bufferBytes > MAX_BUFFER_BYTES) {
      const removed = session.outputBuffer.shift();
      if (removed) session.bufferBytes -= removed.length;
    }
    broadcast({ type: "output", session: name, data });
  });

  p.onExit(({ exitCode }) => {
    log.info("Session exited", { session: name, exitCode });
    session.alive = false;
    broadcast({ type: "exit", session: name, code: exitCode });
  });

  sessions.set(name, session);
  log.info("Session created", { session: name, pid: p.pid });
  return session;
}

function ensureSession(name, cols, rows) {
  return sessions.get(name) || spawnSession(name, cols, rows);
}

function removeSession(name) {
  const session = sessions.get(name);
  if (!session) return false;
  if (session.alive) session.pty.kill();
  sessions.delete(name);
  for (const [cid, info] of clients) {
    if (info.session === name) clients.delete(cid);
  }
  broadcast({ type: "session-removed", session: name });
  log.info("Session removed", { session: name });
  return true;
}

function renameSession(oldName, newName) {
  const session = sessions.get(oldName);
  if (!session || sessions.has(newName)) return false;
  sessions.delete(oldName);
  sessions.set(newName, session);
  for (const [, info] of clients) {
    if (info.session === oldName) info.session = newName;
  }
  broadcast({ type: "session-renamed", session: oldName, newName });
  log.info("Session renamed", { from: oldName, to: newName });
  return true;
}

// --- RPC handlers: msg in, response out ---

const rpcHandlers = {
  "list-sessions": () =>
    ({ sessions: sessionList() }),

  "create-session": (msg) =>
    sessions.has(msg.name)
      ? { error: "Session already exists" }
      : (spawnSession(msg.name), { name: msg.name }),

  "delete-session": (msg) =>
    removeSession(msg.name) ? { ok: true } : { error: "Not found" },

  "rename-session": (msg) =>
    renameSession(msg.oldName, msg.newName)
      ? { name: msg.newName }
      : { error: "Not found or name taken" },

  "attach": (msg, socket) => {
    const name = msg.session || "default";
    const session = ensureSession(name, msg.cols, msg.rows);
    clients.set(msg.clientId, { session: name, socket });
    return { buffer: session.outputBuffer.join(""), alive: session.alive };
  },

  "detach": (msg) =>
    (clients.delete(msg.clientId), { ok: true }),

  "get-shortcuts": () => {
    try {
      return { shortcuts: JSON.parse(readFileSync(SHORTCUTS_PATH, "utf-8")) };
    } catch {
      return { shortcuts: [] };
    }
  },

  "set-shortcuts": (msg) => {
    try {
      writeFileSync(SHORTCUTS_PATH, JSON.stringify(msg.data, null, 2) + "\n");
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  },
};

// --- Message dispatch (boundary) ---

function handleMessage(msg, socket) {
  const { id, type } = msg;

  // Fire-and-forget: no response needed
  if (!id) {
    if (type === "input")  aliveSessionFor(msg.clientId)?.pty.write(msg.data);
    if (type === "resize") aliveSessionFor(msg.clientId)?.pty.resize(msg.cols, msg.rows);
    if (type === "detach") clients.delete(msg.clientId);
    return;
  }

  // RPC: dispatch to handler, send response
  const handler = rpcHandlers[type];
  const response = handler ? handler(msg, socket) : { error: "Unknown message type" };
  socket.write(encode({ id, ...response }));
}

// --- Stale socket detection ---

function probeSocket() {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) return resolve(false);
    const probe = createConnection(SOCKET_PATH);
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => resolve(false));
  });
}

// --- Start ---

async function start() {
  if (await probeSocket()) {
    log.error("Another daemon is already running", { socket: SOCKET_PATH });
    process.exit(1);
  }
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
    log.info("Removed stale socket file");
  }

  const server = createServer((socket) => {
    log.info("UI server connected");
    uiSockets.add(socket);
    socket.on("data", decoder((msg) => handleMessage(msg, socket)));
    socket.on("close", () => {
      log.info("UI server disconnected");
      uiSockets.delete(socket);
      for (const [cid, info] of clients) {
        if (info.socket === socket) clients.delete(cid);
      }
    });
    socket.on("error", (err) => log.error("Socket error", { error: err.message }));
  });

  function cleanup() {
    log.info("Shutting down daemon");
    for (const [, session] of sessions) {
      if (session.alive) session.pty.kill();
    }
    try { unlinkSync(SOCKET_PATH); } catch {}
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("unhandledRejection", (err) => {
    log.error("Unhandled rejection", { error: err?.message || String(err) });
  });

  server.listen(SOCKET_PATH, () => {
    log.info("Katulong daemon listening", { socket: SOCKET_PATH });
  });
}

start();
