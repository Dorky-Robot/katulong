import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * Centralized environment variable configuration.
 *
 * All process.env reads in production code should go through this module.
 * This provides a single source of truth for which environment variables
 * Katulong supports, what their defaults are, and where they are used.
 *
 * Supported environment variables:
 *
 *   PORT               — HTTP server listen port (default: 3001)
 *   SSH_PORT           — SSH server listen port (default: 2222)
 *   KATULONG_DATA_DIR  — Directory for persistent data (auth state, config, etc.)
 *                        Default: ~/.katulong
 *   KATULONG_SOCK      — Unix socket path for daemon IPC (default: /tmp/katulong-daemon.sock)
 *   KATULONG_NO_AUTH   — Set to "1" to disable authentication entirely (DANGEROUS)
 *   SSH_PASSWORD       — SSH access password; auto-generated if not set
 *   SHELL              — Shell to spawn in PTY sessions (default: /bin/zsh)
 *   NODE_ENV           — Runtime environment: "production" | "development" | "test"
 *                        (default: "production")
 *   LOG_LEVEL          — Minimum log level: "debug" | "info" | "warn" | "error"
 *                        (default: "info")
 *   DRAIN_TIMEOUT      — Graceful shutdown drain timeout in ms (default: 30000)
 *   HOME               — User home directory; used as the initial cwd for PTY sessions
 */

const _sshPasswordProvided = Boolean(process.env.SSH_PASSWORD);
const _sshPassword = process.env.SSH_PASSWORD || randomBytes(16).toString("hex");

const config = Object.freeze({
  // HTTP server
  port: parseInt(process.env.PORT || "3001", 10),

  // SSH server
  sshPort: parseInt(process.env.SSH_PORT || "2222", 10),
  sshHost: process.env.SSH_HOST || "localhost",

  // Data directory for persistent storage
  dataDir: process.env.KATULONG_DATA_DIR || join(homedir(), ".katulong"),

  // Unix socket path for daemon IPC
  socketPath: process.env.KATULONG_SOCK || "/tmp/katulong-daemon.sock",

  // Disable authentication entirely (for dev/testing only — never use in production)
  noAuth: process.env.KATULONG_NO_AUTH === "1",

  // SSH access password (auto-generated if not provided)
  sshPassword: _sshPassword,

  // Whether SSH_PASSWORD was explicitly set (used to decide whether to log the generated one)
  sshPasswordProvided: _sshPasswordProvided,

  // Shell binary for PTY sessions
  shell: process.env.SHELL || "/bin/zsh",

  // Runtime environment
  nodeEnv: process.env.NODE_ENV || "production",

  // Log level threshold
  logLevel: process.env.LOG_LEVEL || "info",

  // Graceful shutdown drain timeout (ms)
  drainTimeout: parseInt(process.env.DRAIN_TIMEOUT || "30000", 10),

  // User home directory (used as initial cwd for PTY sessions)
  home: process.env.HOME || null,
});

export default config;

/**
 * Ensure the data directory exists with owner-only permissions.
 * Call this before any file I/O against the data directory.
 */
export function ensureDataDir() {
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  } catch {
    // May fail in test environments or read-only filesystems
  }
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
