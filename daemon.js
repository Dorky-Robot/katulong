import { createServer } from "node:net";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import pty from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const SHELL = process.env.SHELL || "/bin/zsh";
const SHORTCUTS_PATH = join(__dirname, "shortcuts.json");

// --- Session management ---

const sessions = new Map();
const MAX_BUFFER = 5000;

// Map<clientId, { session: string, socket: net.Socket }>
const clients = new Map();

// All connected UI server sockets
const uiSockets = new Set();

function broadcast(msg) {
  const line = JSON.stringify(msg) + "\n";
  for (const sock of uiSockets) {
    sock.write(line);
  }
}

function createSession(name) {
  if (sessions.has(name)) return { existing: true, session: sessions.get(name) };

  const p = pty.spawn(SHELL, ["-l"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const session = { pty: p, outputBuffer: [], alive: true };

  p.onData((data) => {
    session.outputBuffer.push(data);
    while (session.outputBuffer.length > MAX_BUFFER) session.outputBuffer.shift();
    broadcast({ type: "output", session: name, data });
  });

  p.onExit(({ exitCode }) => {
    console.log(`Session "${name}" exited (${exitCode})`);
    session.alive = false;
    broadcast({ type: "exit", session: name, code: exitCode });
  });

  sessions.set(name, session);
  console.log(`Session "${name}" created (pid ${p.pid})`);
  return { existing: false, session };
}

function removeSession(name) {
  const session = sessions.get(name);
  if (!session) return false;
  if (session.alive) {
    session.pty.kill();
  }
  sessions.delete(name);
  // Detach any clients watching this session
  for (const [clientId, info] of clients) {
    if (info.session === name) {
      clients.delete(clientId);
    }
  }
  broadcast({ type: "session-removed", session: name });
  console.log(`Session "${name}" removed`);
  return true;
}

function renameSession(oldName, newName) {
  const session = sessions.get(oldName);
  if (!session) return false;
  if (sessions.has(newName)) return false;
  sessions.delete(oldName);
  sessions.set(newName, session);
  // Update client tracking
  for (const [clientId, info] of clients) {
    if (info.session === oldName) {
      info.session = newName;
    }
  }
  broadcast({ type: "session-renamed", session: oldName, newName });
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

// --- Request handling ---

function handleMessage(msg, socket) {
  const { id, type } = msg;

  // Fire-and-forget messages (no id)
  if (type === "input") {
    const info = clients.get(msg.clientId);
    if (info) {
      const session = sessions.get(info.session);
      if (session && session.alive) {
        session.pty.write(msg.data);
      }
    }
    return;
  }

  if (type === "resize") {
    const info = clients.get(msg.clientId);
    if (info) {
      const session = sessions.get(info.session);
      if (session && session.alive) {
        session.pty.resize(msg.cols, msg.rows);
      }
    }
    return;
  }

  if (type === "detach" && !id) {
    clients.delete(msg.clientId);
    return;
  }

  // Request/response messages (have id)
  let response;

  switch (type) {
    case "list-sessions": {
      response = { sessions: sessionList() };
      break;
    }
    case "create-session": {
      const name = msg.name;
      if (sessions.has(name)) {
        response = { error: "Session already exists" };
      } else {
        createSession(name);
        response = { name };
      }
      break;
    }
    case "delete-session": {
      if (removeSession(msg.name)) {
        response = { ok: true };
      } else {
        response = { error: "Not found" };
      }
      break;
    }
    case "rename-session": {
      if (renameSession(msg.oldName, msg.newName)) {
        response = { name: msg.newName };
      } else {
        response = { error: "Not found or name taken" };
      }
      break;
    }
    case "attach": {
      const name = msg.session || "default";
      const { session } = createSession(name); // lazy create
      clients.set(msg.clientId, { session: name, socket });
      response = {
        buffer: session.outputBuffer.join(""),
        alive: session.alive,
      };
      break;
    }
    case "detach": {
      clients.delete(msg.clientId);
      response = { ok: true };
      break;
    }
    case "get-shortcuts": {
      try {
        const data = readFileSync(SHORTCUTS_PATH, "utf-8");
        response = { shortcuts: JSON.parse(data) };
      } catch {
        response = { shortcuts: [] };
      }
      break;
    }
    case "set-shortcuts": {
      try {
        writeFileSync(SHORTCUTS_PATH, JSON.stringify(msg.data, null, 2) + "\n");
        response = { ok: true };
      } catch (e) {
        response = { error: e.message };
      }
      break;
    }
    default:
      response = { error: "Unknown message type" };
  }

  socket.write(JSON.stringify({ id, ...response }) + "\n");
}

// --- Stale socket detection ---

function probeSocket() {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) {
      resolve(false);
      return;
    }
    const probe = createConnection(SOCKET_PATH);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true); // another daemon is running
    });
    probe.on("error", () => {
      resolve(false); // stale socket
    });
  });
}

// --- Start ---

async function start() {
  const alive = await probeSocket();
  if (alive) {
    console.error("Another daemon is already running on", SOCKET_PATH);
    process.exit(1);
  }

  // Remove stale socket file
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
    console.log("Removed stale socket file");
  }

  const server = createServer((socket) => {
    console.log("UI server connected");
    uiSockets.add(socket);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            handleMessage(msg, socket);
          } catch (e) {
            console.error("Bad IPC message:", e.message);
          }
        }
      }
    });

    socket.on("close", () => {
      console.log("UI server disconnected");
      uiSockets.delete(socket);
      // Detach all clients that came from this socket
      for (const [clientId, info] of clients) {
        if (info.socket === socket) {
          clients.delete(clientId);
        }
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err.message);
    });
  });

  function cleanup() {
    console.log("\nShutting down daemon...");
    for (const [name, session] of sessions) {
      if (session.alive) {
        session.pty.kill();
      }
    }
    try {
      unlinkSync(SOCKET_PATH);
    } catch {}
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  server.listen(SOCKET_PATH, () => {
    console.log(`Katulong daemon listening on ${SOCKET_PATH}`);
  });
}

start();
