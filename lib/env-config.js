import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 *   KATULONG_DATA_DIR  — Directory for persistent data (auth state, config, etc.)
 *                        Default: ~/.katulong
 *   SHELL              — Shell to spawn in tmux sessions (default: /bin/zsh)
 *   NODE_ENV           — Runtime environment: "production" | "development" | "test"
 *                        (default: "production")
 *   LOG_LEVEL          — Minimum log level: "debug" | "info" | "warn" | "error"
 *                        (default: "info")
 *   DRAIN_TIMEOUT      — Graceful shutdown drain timeout in ms (default: 30000)
 *   HOME               — User home directory; used as the initial cwd for tmux sessions
 *   KATULONG_TRUST_PROXY_SECRET — Shared secret for trusted reverse proxy auth.
 *                        When set, requests with matching X-Katulong-Auth header
 *                        bypass authentication. Used by abot's reverse proxy.
 */

// Read DRAIN_TIMEOUT once so both the server-side drain wait and the
// caller-side stop watchdog are derived from the same source. Without
// this single read, `katulong update` could SIGKILL a server that was
// still legitimately inside its drain window — see SHUTDOWN_TAIL_SLACK_MS.
const drainTimeoutMs = parseInt(process.env.DRAIN_TIMEOUT || "30000", 10);

// Upper bound on the synchronous tail of graceful shutdown after the
// drain wait completes (sessionManager.shutdown → shutdownPlugins →
// cleanupPidFile → process.exit). Plugins are user-defined so this is a
// pessimistic budget, not a measured value.
const SHUTDOWN_TAIL_SLACK_MS = 3000;

const config = Object.freeze({
  // HTTP server
  port: parseInt(process.env.PORT || "3001", 10),
  bindHost: process.env.KATULONG_BIND_HOST || "127.0.0.1",

  // Data directory for persistent storage
  dataDir: process.env.KATULONG_DATA_DIR || join(homedir(), ".katulong"),

  // Shell binary for PTY sessions
  shell: process.env.SHELL || "/bin/zsh",

  // Runtime environment
  nodeEnv: process.env.NODE_ENV || "production",

  // Log level threshold
  logLevel: process.env.LOG_LEVEL || "info",

  // Graceful shutdown drain timeout (ms). Server-side: how long the
  // shutdown handler waits for WebSocket clients to drain before
  // force-terminating them.
  drainTimeout: drainTimeoutMs,

  // Caller-side watchdog budget for stopping a running server (ms).
  // Must always exceed the server's own self-imposed shutdown bound
  // (drainTimeout + synchronous tail) so a healthy graceful exit always
  // wins the race against the SIGKILL fallback in safeStopServer.
  // Derived from drainTimeout so DRAIN_TIMEOUT env overrides propagate
  // to both sides automatically — there is no separate knob to forget.
  shutdownBudget: drainTimeoutMs + SHUTDOWN_TAIL_SLACK_MS,

  // User home directory (used as initial cwd for PTY sessions)
  home: process.env.HOME || null,

  // Trusted reverse proxy secret — when set, requests with a matching
  // X-Katulong-Auth header bypass authentication. Used by abot to proxy
  // requests through to katulong without requiring a second passkey.
  trustProxySecret: process.env.KATULONG_TRUST_PROXY_SECRET || null,
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
export const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
