import { execSync } from "node:child_process";
import { isDaemonRunning, isServerRunning, ROOT } from "../process-manager.js";
import { join } from "node:path";

export default async function stop(args) {
  const target = args.find(arg => !arg.startsWith("--")) || "both";

  // Validate target
  if (!["daemon", "server", "both"].includes(target)) {
    console.error(`Error: Invalid target '${target}'`);
    console.error("Usage: katulong stop [daemon|server|both]");
    process.exit(1);
  }

  const daemon = isDaemonRunning();
  const server = isServerRunning();

  const shouldStopDaemon = (target === "daemon" || target === "both");
  const shouldStopServer = (target === "server" || target === "both");

  if (shouldStopDaemon && !daemon.running && shouldStopServer && !server.running) {
    console.log("Katulong is not running");
    return;
  }

  if (shouldStopDaemon && !daemon.running && !shouldStopServer) {
    console.log("Daemon is not running");
    return;
  }

  if (shouldStopServer && !server.running && !shouldStopDaemon) {
    console.log("Server is not running");
    return;
  }

  console.log(`Stopping ${target === "both" ? "Katulong" : target}...\n`);

  // Stop server first if requested
  if (shouldStopServer && server.running) {
    console.log(`Stopping server (PID ${server.pid})...`);
    try {
      process.kill(server.pid, "SIGTERM");
      // Wait a moment for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if still running, force kill if necessary
      if (isServerRunning().running) {
        console.log("  Server did not stop gracefully, forcing...");
        process.kill(server.pid, "SIGKILL");
      }
      console.log("✓ Server stopped");
    } catch (err) {
      console.error(`✗ Failed to stop server: ${err.message}`);
    }
  }

  // Stop daemon if requested using our safe kill script
  if (shouldStopDaemon && daemon.running) {
    console.log(`Stopping daemon (PID ${daemon.pid})...`);
    try {
      execSync(join(ROOT, "scripts/kill-daemon.sh"), {
        stdio: "pipe",
        encoding: "utf-8",
      });
      console.log("✓ Daemon stopped");
    } catch (err) {
      console.error(`✗ Failed to stop daemon: ${err.message}`);
    }
  }

  // Final verification
  const daemonCheck = isDaemonRunning();
  const serverCheck = isServerRunning();

  if (target === "both") {
    if (!daemonCheck.running && !serverCheck.running) {
      console.log("\n✓ All processes stopped");
    } else {
      console.error("\n✗ Some processes may still be running");
      console.error("  Run 'katulong status' to check");
      process.exit(1);
    }
  } else if (target === "daemon") {
    if (!daemonCheck.running) {
      console.log("\n✓ Daemon stopped");
    } else {
      console.error("\n✗ Daemon may still be running");
      process.exit(1);
    }
  } else if (target === "server") {
    if (!serverCheck.running) {
      console.log("\n✓ Server stopped");
    } else {
      console.error("\n✗ Server may still be running");
      process.exit(1);
    }
  }
}
