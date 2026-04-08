/**
 * Graceful server shutdown — SIGTERM/SIGINT orchestration.
 *
 * Extracted from server.js because the shutdown dance is a cohesive
 * ordered sequence (broadcast drain → close HTTP → wait → close WS →
 * drain → force-terminate → shutdown subsystems → remove PID files)
 * that doesn't belong mixed into module-level server setup. Keeping
 * it here makes the sequence readable top-to-bottom and lets the
 * `draining` flag live next to the code that owns it.
 *
 * The `draining` flag is exposed via `isDraining()` because the HTTP
 * routes need to report it to clients for fast reconnect. It is NOT
 * mutated from the outside — only `gracefulShutdown()` flips it, so
 * callers get a read-only view.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { log } from "./log.js";

/**
 * @param {object} opts
 * @param {import("node:http").Server} opts.server
 * @param {import("ws").WebSocketServer} opts.wss
 * @param {(payload: object) => void} opts.broadcastToAll
 * @param {(code?: number, reason?: string) => void} opts.closeAllWebSockets
 * @param {{ shutdown: () => void }} opts.sessionManager
 * @param {{ shutdown: () => void }} opts.helmSessionManager
 * @param {() => Promise<void>} opts.shutdownPlugins
 * @param {number} opts.drainTimeoutMs
 * @param {string} opts.pidPath - Path to server.pid (cleaned up if ours)
 * @param {string} opts.infoPath - Path to server.json (cleaned up if ours)
 */
export function createServerShutdown({
  server,
  wss,
  broadcastToAll,
  closeAllWebSockets,
  sessionManager,
  helmSessionManager,
  shutdownPlugins,
  drainTimeoutMs,
  pidPath,
  infoPath,
}) {
  let draining = false;
  let shutdownInProgress = false;

  /**
   * Remove the PID and server-info files, but only if they belong to
   * our process. Another server may have overwritten them between our
   * startup and shutdown — leaving those alone prevents clobbering the
   * newer instance's state.
   */
  function cleanupPidFile() {
    try {
      if (existsSync(pidPath)) {
        const content = readFileSync(pidPath, "utf-8").trim();
        if (content === String(process.pid)) {
          unlinkSync(pidPath);
        }
      }
    } catch {
      // Best-effort cleanup
    }
    try {
      if (existsSync(infoPath)) {
        const info = JSON.parse(readFileSync(infoPath, "utf-8"));
        if (info.pid === process.pid) {
          unlinkSync(infoPath);
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }

  async function gracefulShutdown(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    draining = true;

    log.info("Graceful shutdown starting", { signal, pid: process.pid });

    // 1. Notify all WebSocket clients that this server is draining
    //    (triggers fast reconnect on the frontend)
    broadcastToAll({ type: "server-draining" });

    // 2. Stop accepting new HTTP connections — releases the port immediately
    server.close(() => {
      log.info("HTTP server closed, no more new connections");
    });

    // 3. Wait briefly for clients to receive the draining message, then close WebSockets
    await new Promise((resolve) => setTimeout(resolve, 500));

    closeAllWebSockets(1001, "Server shutting down");

    // 4. Wait for WebSocket connections to drain (up to drainTimeoutMs)
    const drainDeadline = Date.now() + drainTimeoutMs;
    while (wss.clients.size > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 5. Force-close any remaining connections
    for (const client of wss.clients) {
      client.terminate();
    }

    // 6. Shutdown session manager (close control mode procs, leave tmux sessions alive)
    sessionManager.shutdown();
    helmSessionManager.shutdown();

    // 7. Shutdown plugins
    await shutdownPlugins();

    // 8. Clean up PID file
    cleanupPidFile();

    log.info("Graceful shutdown complete", { signal });
    process.exit(0);
  }

  /**
   * Install SIGTERM/SIGINT handlers. Called once at startup, after
   * the server is listening.
   */
  function install() {
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }

  return {
    gracefulShutdown,
    cleanupPidFile,
    install,
    isDraining: () => draining,
  };
}
