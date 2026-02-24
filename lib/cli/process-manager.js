import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import envConfig, { ensureDataDir } from "../env-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const DATA_DIR = envConfig.dataDir;
ensureDataDir();

// Validate SOCKET_PATH: only allow safe filesystem path characters
const SOCKET_PATH = /^[a-zA-Z0-9/_\-. ]+$/.test(envConfig.socketPath)
  ? envConfig.socketPath
  : "/tmp/katulong-daemon.sock";

const PID_PATH = join(DATA_DIR, "daemon.pid");
const SERVER_PID_PATH = join(DATA_DIR, "server.pid");

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
export function readPidFile(path = PID_PATH) {
  try {
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Check if daemon is running
 */
export function isDaemonRunning() {
  // Method 1: Check PID file
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    return { running: true, pid, method: "pidfile" };
  }

  // Method 2: Check socket file
  if (existsSync(SOCKET_PATH)) {
    try {
      // Try to find process using the socket
      const result = execSync(`lsof -t "${SOCKET_PATH}" 2>/dev/null || true`, {
        encoding: "utf-8",
      }).trim();
      if (result) {
        const socketPid = parseInt(result, 10);
        return { running: true, pid: socketPid, method: "socket" };
      }
    } catch {
      // Socket exists but no process owns it (stale)
    }
  }

  // Method 3: Check by process name
  try {
    const result = execSync("pgrep -f katulong-daemon 2>/dev/null || true", {
      encoding: "utf-8",
    }).trim();
    if (result) {
      const namePid = parseInt(result.split("\n")[0], 10);
      return { running: true, pid: namePid, method: "processname" };
    }
  } catch {
    // Not found
  }

  return { running: false, pid: null, method: null };
}

/**
 * Check if server is running (checks PID file first, falls back to lsof)
 */
export function isServerRunning() {
  const port = envConfig.port;

  // Method 1: Check PID file (fast, reliable)
  const pid = readPidFile(SERVER_PID_PATH);
  if (pid && isProcessRunning(pid)) {
    return { running: true, pid, port, method: "pidfile" };
  }

  // Method 2: Fall back to lsof for compatibility
  try {
    const result = execSync(`lsof -ti:${port} 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    if (result) {
      const lsofPid = parseInt(result, 10);
      return { running: true, pid: lsofPid, port, method: "lsof" };
    }
  } catch {
    // Not found
  }
  return { running: false, pid: null, port };
}

/**
 * Get URLs where Katulong is accessible
 */
export function getUrls() {
  return {
    http: `http://localhost:${envConfig.port}`,
    ssh: `ssh://localhost:${envConfig.sshPort}`,
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

export { DATA_DIR, SOCKET_PATH, PID_PATH, SERVER_PID_PATH, ROOT };
