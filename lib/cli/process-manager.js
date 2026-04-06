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
 * Check if a process with given PID is running.
 *
 * Uses `kill -0` to probe without sending a signal. Distinguishes:
 *   - ESRCH: no such process → not running
 *   - EPERM: process exists but we can't signal it (different user) → running
 *   - anything else: unknown, treat as not running
 *
 * The EPERM case matters: if a foreign-user katulong server wrote its PID
 * into `server.json` (e.g., running as a different user on a shared box),
 * we should still report it as alive rather than silently "deleting" it
 * from our detection path.
 */
export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Synchronously probe whether something is accepting TCP connections on
 * `localhost:<port>`. Used as a last-resort liveness check when neither
 * `server.json` nor `server.pid` tell us anything.
 *
 * Done via `execSync` + a tiny node one-liner so it works under busybox
 * (Alpine) where `nc`/`lsof`/`ss` flags vary, and so callers stay sync.
 */
function probePort(port) {
  try {
    execSync(
      `node -e "const s=require('net').createConnection(${port},'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))"`,
      { encoding: "utf-8", timeout: 2000 },
    );
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
    // Strict integer validation. `typeof info.pid === "number"` alone would
    // accept 0, negative values, and — in the hypothetical — NaN. pid=0 is
    // especially nasty: process.kill(0, 0) signals the current process group
    // on POSIX and usually succeeds, so `isProcessRunning(0)` returns true,
    // leading readServerInfo to accept a garbage file. Port is similarly
    // bounded to the TCP range so a tampered file can't produce a URL with
    // nonsense like `:99999`.
    if (!Number.isInteger(info?.pid) || info.pid <= 0) return null;
    if (!Number.isInteger(info?.port) || info.port <= 0 || info.port > 65535) return null;
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
  if (probePort(port)) {
    return { running: true, pid: null, port, method: "probe" };
  }
  return { running: false, pid: null, port };
}

/**
 * Resolve the base URL for talking to the running katulong server.
 *
 * Resolution order:
 *   1. `server.json` — authoritative, written by the live server
 *   2. `KATULONG_PORT` env / `envConfig.port` — cheap fallback
 *
 * Why not probe the network here? `getServerBaseUrl` is called on every CLI
 * invocation that talks to the server (including the common "server is not
 * running" path). A synchronous TCP probe with a 2s timeout would add up to
 * 2 seconds of latency to every miss. Liveness belongs in `isServerRunning`,
 * not URL resolution — the caller checks `ensureRunning()` first anyway.
 *
 * Why not just trust `KATULONG_PORT` first? In long-lived tmux panes the var
 * can outlive the server it referred to: the server writes it into tmux's
 * global env at startup, but existing panes never see updates. A user with a
 * stale `KATULONG_PORT=63935` and a real server on `:3001` would otherwise
 * see "Server is not running" from every CLI command. server.json wins.
 */
export function getServerBaseUrl() {
  // 1. Authoritative: live server.json
  const info = readServerInfo();
  if (info) return `http://localhost:${info.port}`;

  // 2. Cheap fallback: env hint or config default (no network I/O)
  const envPort = parseInt(process.env.KATULONG_PORT || "", 10);
  const portValid = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535;
  const port = portValid ? envPort : envConfig.port;
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
