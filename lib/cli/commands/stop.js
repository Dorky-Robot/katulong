import { execSync } from "node:child_process";
import { isServerRunning } from "../process-manager.js";

/**
 * Find the PID of the process listening on a port via lsof.
 * Returns a numeric PID or null.
 */
function findPidByPort(port) {
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

export default async function stop() {
  const server = isServerRunning();

  if (!server.running) {
    console.log("Katulong is not running");
    return;
  }

  // If the PID file was stale/missing, resolve the actual PID from the port
  const pid = server.pid ?? findPidByPort(server.port);

  if (!pid) {
    console.error(
      `✗ Server appears to be running on port ${server.port} but could not determine its PID`,
    );
    console.error(
      `  Try: lsof -ti:${server.port} | xargs kill`,
    );
    process.exit(1);
    return;
  }

  console.log("Stopping Katulong...\n");

  console.log(`Stopping server (PID ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
    // Wait for graceful shutdown (server may be draining WebSocket connections)
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check if still running, force kill if necessary
    if (isServerRunning().running) {
      console.log("  Server did not stop gracefully, forcing...");
      process.kill(pid, "SIGKILL");
    }
    console.log("✓ Server stopped");
  } catch (err) {
    console.error(`✗ Failed to stop server: ${err.message}`);
  }

  // Final verification
  const serverCheck = isServerRunning();
  if (!serverCheck.running) {
    console.log("\n✓ Katulong stopped");
  } else {
    console.error("\n✗ Server may still be running");
    console.error("  Run 'katulong status' to check");
    process.exit(1);
  }
}
