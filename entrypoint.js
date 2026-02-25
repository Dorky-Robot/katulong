import { fork } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import envConfig from "./lib/env-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const children = [];
let shuttingDown = false;

function spawnChild(script) {
  const child = fork(join(__dirname, script), { stdio: "inherit" });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return; // expected exit during shutdown
    // Unexpected child exit — trigger orderly shutdown
    console.error(`[entrypoint] ${script} exited unexpectedly (code=${code}, signal=${signal})`);
    shutdown();
  });
  return child;
}

/**
 * Probe the daemon's Unix socket until it accepts a connection.
 * Retries every 100ms up to timeoutMs (default 10s).
 */
function waitForDaemon(socketPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt() {
      if (Date.now() > deadline) {
        return reject(new Error(`Daemon not ready after ${timeoutMs}ms`));
      }
      const probe = createConnection(socketPath);
      probe.on("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.on("error", () => {
        setTimeout(attempt, 100);
      });
    }

    attempt();
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  const HARD_KILL_MS = 15000;
  const SERVER_DRAIN_MS = 10000;

  // Find server and daemon children
  const serverChild = children.find(c => c.spawnargs?.includes("server.js")) || children[1];
  const daemonChild = children.find(c => c.spawnargs?.includes("daemon.js")) || children[0];

  // 1. SIGTERM server first (it drains WebSockets)
  if (serverChild && !serverChild.killed) {
    serverChild.kill("SIGTERM");

    // Wait for server to exit (up to SERVER_DRAIN_MS)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, SERVER_DRAIN_MS);
      serverChild.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  // 2. Then SIGTERM daemon
  if (daemonChild && !daemonChild.killed) {
    daemonChild.kill("SIGTERM");
  }

  // 3. Hard SIGKILL timeout
  const hardKillTimer = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }
    process.exit(1);
  }, HARD_KILL_MS);
  hardKillTimer.unref();

  // Wait for all children to exit
  await Promise.all(children.map(child =>
    new Promise(resolve => {
      if (child.killed || child.exitCode !== null) return resolve();
      child.on("exit", resolve);
    })
  ));

  clearTimeout(hardKillTimer);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start daemon, wait for it to be ready, then start server
const daemonChild = spawnChild("daemon.js");

try {
  await waitForDaemon(envConfig.socketPath);
} catch (err) {
  console.error(`[entrypoint] ${err.message}`);
  process.exit(1);
}

spawnChild("server.js");
