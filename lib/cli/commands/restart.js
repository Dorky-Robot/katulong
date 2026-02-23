import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import stop from "./stop.js";
import start from "./start.js";
import { isServerRunning, readPidFile, isProcessRunning, SERVER_PID_PATH, ROOT, DATA_DIR } from "../process-manager.js";

export default async function restart(args) {
  const target = args.find(arg => !arg.startsWith("--")) || "both";
  const rolling = args.includes("--rolling");

  // Validate target
  if (!["daemon", "server", "both"].includes(target)) {
    console.error(`Error: Invalid target '${target}'`);
    console.error("Usage: katulong restart [daemon|server|both] [--foreground] [--rolling]");
    process.exit(1);
  }

  // Rolling restart only applies to the server
  if (rolling) {
    if (target === "daemon") {
      console.error("Error: --rolling is only supported for server restarts");
      process.exit(1);
    }
    await rollingRestart(args);
    return;
  }

  console.log(`Restarting ${target === "both" ? "Katulong" : target}...\n`);
  await stop(args);
  console.log(""); // Blank line
  await start(args);
}

async function rollingRestart(args) {
  const target = args.find(arg => !arg.startsWith("--")) || "both";
  const port = process.env.PORT || 3001;

  console.log("Rolling restart...\n");

  // 1. Check old server is running
  const oldServer = isServerRunning();
  if (!oldServer.running) {
    console.log("Server is not running, starting normally...");
    await start(args);
    return;
  }

  const oldPid = oldServer.pid;
  console.log(`Old server running (PID ${oldPid})`);

  // 2. Send SIGTERM to old server (starts drain, releases port)
  console.log("Sending SIGTERM to old server (starting drain)...");
  try {
    process.kill(oldPid, "SIGTERM");
  } catch (err) {
    console.error(`Failed to signal old server: ${err.message}`);
    process.exit(1);
  }

  // 3. Poll for port to be free (up to 5s)
  console.log("Waiting for port to be released...");
  const portDeadline = Date.now() + 5000;
  while (Date.now() < portDeadline) {
    // Check if something is still listening on the port
    const check = isServerRunning();
    if (!check.running) break;
    // The old server may still show as running via PID file but has released the port
    // Check more specifically by trying lsof
    await sleep(200);
  }

  // 4. Start new server process
  console.log("Starting new server...");
  const serverLogPath = join(DATA_DIR, "server.log");
  const stdio = ["ignore", openSync(serverLogPath, "a"), openSync(serverLogPath, "a")];

  const serverProcess = spawn(process.execPath, [join(ROOT, "server.js")], {
    detached: true,
    stdio,
    env: { ...process.env, KATULONG_DATA_DIR: DATA_DIR },
  });
  serverProcess.unref();

  // 5. Poll /health for 200 (up to 10s)
  console.log("Waiting for new server to be healthy...");
  const healthDeadline = Date.now() + 10000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data.status === "ok" && data.pid !== oldPid) {
          healthy = true;
          console.log(`New server healthy (PID ${data.pid})`);
          break;
        }
      }
    } catch {
      // Server not ready yet
    }
    await sleep(500);
  }

  if (!healthy) {
    console.error("New server did not become healthy within 10s");
    console.error(`  Check logs: ${serverLogPath}`);
    process.exit(1);
  }

  // 6. Wait for old process to exit (up to 30s, or log warning)
  const exitDeadline = Date.now() + 30000;
  let oldExited = false;
  while (Date.now() < exitDeadline) {
    if (!isProcessRunning(oldPid)) {
      oldExited = true;
      break;
    }
    await sleep(1000);
  }

  if (oldExited) {
    console.log(`Old server (PID ${oldPid}) has exited`);
  } else {
    console.log(`Warning: old server (PID ${oldPid}) still running after 30s`);
  }

  // If target includes daemon, restart it normally (non-rolling)
  if (target === "both") {
    // Daemon doesn't need rolling restart — it's shared
    console.log("\nDaemon is shared between servers and does not need restart.");
  }

  console.log("\n--- Rolling restart complete ---");
  console.log(`  Open: http://localhost:${port}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
