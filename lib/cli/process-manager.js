import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import envConfig, { ensureDataDir } from "../env-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const DATA_DIR = envConfig.dataDir;
ensureDataDir();

const SERVER_PID_PATH = join(DATA_DIR, "server.pid");
const SERVER_INFO_PATH = join(DATA_DIR, "server.json");

/**
 * Check if a process with given PID is running
 */
export function isProcessRunning(pid) {
  try {
    // kill -0 checks if process exists without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from file
 */
export function readPidFile(path = SERVER_PID_PATH) {
  try {
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Read server info file written by the live server.
 *
 * Returns `{ pid, port, host }` for the currently running server, or `null`
 * if no info file exists / it's malformed / the recorded PID is dead.
 *
 * This is the authoritative source for "where is the running server?" — much
 * more reliable than `KATULONG_PORT` env, which can be stale in long-lived
 * shells when the server has been restarted on a different port (KATULONG_PORT
 * is set in tmux's global env at server start, so existing panes never see
 * the update).
 */
export function readServerInfo(path = SERVER_INFO_PATH) {
  try {
    if (!existsSync(path)) return null;
    const info = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof info?.pid !== "number" || typeof info?.port !== "number") {
      return null;
    }
    if (!isProcessRunning(info.pid)) return null;
    return {
      pid: info.pid,
      port: info.port,
      host: typeof info.host === "string" ? info.host : "127.0.0.1",
    };
  } catch {
    return null;
  }
}

/**
 * Check if server is running.
 *
 * Detection order:
 *   1. server.json — written by the live server, includes the actual bound port
 *   2. server.pid  — backwards-compatible PID-only check
 *   3. TCP probe   — port from envConfig, last resort
 */
export function isServerRunning() {
  // Method 1: Read authoritative server info file (includes live port)
  const info = readServerInfo();
  if (info) {
    return { running: true, pid: info.pid, port: info.port, method: "info" };
  }

  // Method 2: Fall back to PID file (older servers / partial state)
  const pid = readPidFile(SERVER_PID_PATH);
  if (pid && isProcessRunning(pid)) {
    return { running: true, pid, port: envConfig.port, method: "pidfile" };
  }

  // Method 3: Probe the configured port (works on all platforms including Alpine/busybox)
  const port = envConfig.port;
  try {
    execSync(
      `node -e "const s=require('net').createConnection(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))"`,
      { encoding: "utf-8", timeout: 2000 },
    );
    return { running: true, pid: null, port, method: "probe" };
  } catch {
    // Not listening
  }
  return { running: false, pid: null, port };
}

/**
 * Resolve the base URL for talking to the running katulong server.
 *
 * Resolution order (mirrors `isServerRunning`):
 *   1. `server.json` — authoritative, written by the live server
 *   2. `envConfig.port` — when the default port is actually accepting connections
 *   3. `KATULONG_PORT` env — last-resort hint when no server is detected yet
 *
 * Why not just trust `KATULONG_PORT` first? In long-lived tmux panes the var
 * can outlive the server it referred to: the server writes it into tmux's
 * global env at startup, but existing panes never see updates. A user with a
 * stale `KATULONG_PORT=63935` and a real server on `:3001` would otherwise
 * see "Server is not running" from every CLI command.
 */
export function getServerBaseUrl() {
  // 1. Authoritative: live server.json
  const info = readServerInfo();
  if (info) return `http://localhost:${info.port}`;

  // 2. Default config port if something is actually listening there
  const defaultPort = envConfig.port;
  try {
    execSync(
      `node -e "const s=require('net').createConnection(${defaultPort},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))"`,
      { encoding: "utf-8", timeout: 2000 },
    );
    return `http://localhost:${defaultPort}`;
  } catch {
    // not listening on default port
  }

  // 3. Last resort: env hint or config default
  const port = process.env.KATULONG_PORT || defaultPort;
  return `http://localhost:${port}`;
}

/**
 * Get URLs where Katulong is accessible
 */
export function getUrls() {
  return {
    http: `http://localhost:${envConfig.port}`,
  };
}

/**
 * Detect how Katulong was installed.
 * Returns "homebrew", "npm-global", "git", or "dev".
 *
 * Accepts optional parameters for testing:
 * @param {string} [root] - Override ROOT path (defaults to module ROOT)
 * @param {function} [fsExists] - Override existsSync (defaults to fs.existsSync)
 */
export function detectInstallMethod(root = ROOT, fsExists = existsSync) {
  // Homebrew: installed via /usr/local/opt or /opt/homebrew/opt
  if (
    root.includes("/usr/local/opt/katulong") ||
    root.includes("/opt/homebrew/opt/katulong")
  ) {
    return "homebrew";
  }

  // Homebrew Cellar paths (also Homebrew)
  if (
    root.includes("/usr/local/Cellar/katulong") ||
    root.includes("/opt/homebrew/Cellar/katulong")
  ) {
    return "homebrew";
  }

  // Global npm: inside node_modules/katulong
  if (root.includes("/node_modules/katulong")) {
    return "npm-global";
  }

  // Git-based: check if .git exists in root
  if (fsExists(join(root, ".git"))) {
    // If it's in a well-known manual install path, call it "git"
    if (root.includes("/.katulong")) {
      return "git";
    }
    // Otherwise it's a dev checkout (npm link, local clone)
    return "dev";
  }

  // Fallback: if in /usr/local or /opt/homebrew but not in opt/Cellar, still treat as homebrew
  if (root.includes("/usr/local") || root.includes("/opt/homebrew")) {
    return "homebrew";
  }

  return "dev";
}

/**
 * Find the PID of the process listening on a port via lsof.
 * Returns a numeric PID or null.
 */
export function findPidByPort(port) {
  try {
    const out = execSync(`lsof -ti:${port}`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    const pid = parseInt(out.split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export { DATA_DIR, SERVER_PID_PATH, SERVER_INFO_PATH, ROOT };
