import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// Detect if running from Homebrew/npm install (not dev mode)
function isInstalledGlobally() {
  // Check if running from /usr/local or /opt/homebrew (Homebrew)
  if (ROOT.includes("/usr/local") || ROOT.includes("/opt/homebrew")) {
    return true;
  }
  // Check if running from global node_modules
  if (ROOT.includes("/node_modules/katulong")) {
    return true;
  }
  return false;
}

// Environment defaults
// Use ~/.config/katulong for global installs, project dir for development
const DEFAULT_DATA_DIR = isInstalledGlobally()
  ? join(homedir(), ".config", "katulong")
  : ROOT;

const DATA_DIR = process.env.KATULONG_DATA_DIR || DEFAULT_DATA_DIR;
const SOCKET_PATH = process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock";
const PID_PATH = join(DATA_DIR, "daemon.pid");

// Ensure data directory exists
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // Directory might already exist
}

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
 * Check if server is running (checks for process listening on PORT)
 */
export function isServerRunning() {
  const port = process.env.PORT || 3001;
  try {
    const result = execSync(`lsof -ti:${port} 2>/dev/null || true`, {
      encoding: "utf-8",
    }).trim();
    if (result) {
      const pid = parseInt(result, 10);
      return { running: true, pid, port };
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
  const httpPort = process.env.PORT || 3001;
  const sshPort = process.env.SSH_PORT || 2222;

  return {
    http: `http://localhost:${httpPort}`,
    ssh: `ssh://localhost:${sshPort}`,
  };
}

export { DATA_DIR, SOCKET_PATH, PID_PATH, ROOT };
