import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import stop from "./stop.js";
import start from "./start.js";
import { isServerRunning, isProcessRunning, findPidByPort, ROOT, DATA_DIR } from "../process-manager.js";
import { safeStopServer } from "../safe-stop.js";
import envConfig from "../../env-config.js";

export default async function restart(args) {
  const rolling = args.includes("--rolling");

  if (rolling) {
    await rollingRestart(args);
    return;
  }

  console.log("Restarting Katulong...\n");
  await stop(args);
  console.log(""); // Blank line
  await start(args);
}

async function rollingRestart(args) {
  const port = envConfig.port;

  console.log("Rolling restart...\n");

  // 1. Check old server is running
  const oldServer = isServerRunning();
  if (!oldServer.running) {
    console.log("Server is not running, starting normally...");
    await start(args);
    return;
  }

  const oldPid = oldServer.pid ?? findPidByPort(port);
  if (!oldPid) {
    console.error(
      `✗ Server appears to be running on port ${port} but could not determine its PID`,
    );
    console.error(`  Falling back to stop + start...`);
    await stop(args);
    console.log("");
    await start(args);
    return;
  }
  console.log(`Old server running (PID ${oldPid})`);

  // 2. Stop the old server safely — routes through launchctl unload when
  // a LaunchAgent plist exists, so a KeepAlive supervisor can't respawn
  // the process mid-restart. Polls the specific old PID (not the port),
  // so a different PID listening on the same port can't confuse us.
  console.log("Stopping old server...");
  const stopResult = await safeStopServer({ pid: oldPid });
  if (stopResult.usedLaunchctl) {
    console.log("  Routed through launchctl (LaunchAgent detected)");
  }
  if (stopResult.escalated) {
    console.log("  Process did not exit gracefully, sent SIGKILL");
  }
  if (!stopResult.stopped) {
    console.error(
      `Failed to stop old server${stopResult.error ? `: ${stopResult.error}` : ""}`,
    );
    process.exit(1);
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

  console.log("\n--- Rolling restart complete ---");
  console.log(`  Open: http://localhost:${port}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
