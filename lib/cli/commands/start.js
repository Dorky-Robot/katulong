import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { isDaemonRunning, isServerRunning, ROOT, DATA_DIR } from "../process-manager.js";
import { join } from "node:path";

export default async function start(args) {
  const target = args.find(arg => !arg.startsWith("--")) || "both";
  const detached = !args.includes("--foreground");

  // Validate target
  if (!["daemon", "server", "both"].includes(target)) {
    console.error(`Error: Invalid target '${target}'`);
    console.error("Usage: katulong start [daemon|server|both] [--foreground]");
    process.exit(1);
  }

  const daemon = isDaemonRunning();
  const server = isServerRunning();

  // Check if already running
  const shouldStartDaemon = (target === "daemon" || target === "both");
  const shouldStartServer = (target === "server" || target === "both");

  if (shouldStartDaemon && daemon.running && shouldStartServer && server.running) {
    console.log("Katulong is already running");
    console.log(`  Daemon: PID ${daemon.pid}`);
    console.log(`  Server: PID ${server.pid}`);
    console.log("\nRun 'katulong status' for more information");
    return;
  }

  if (shouldStartDaemon && daemon.running && !shouldStartServer) {
    console.log(`Daemon is already running (PID ${daemon.pid})`);
    return;
  }

  if (shouldStartServer && server.running && !shouldStartDaemon) {
    console.log(`Server is already running (PID ${server.pid})`);
    return;
  }

  console.log(`Starting ${target === "both" ? "Katulong" : target}...\n`);

  // Start daemon if requested and not running
  if (shouldStartDaemon && !daemon.running) {
    console.log("Starting daemon...");

    // Set up log file redirection for detached mode
    const daemonLogPath = join(DATA_DIR, "daemon.log");
    const stdio = detached
      ? ["ignore", openSync(daemonLogPath, "a"), openSync(daemonLogPath, "a")]
      : "inherit";

    const daemonProcess = spawn(process.execPath, [join(ROOT, "daemon.js")], {
      detached,
      stdio,
      env: { ...process.env, KATULONG_DATA_DIR: DATA_DIR },
    });

    if (detached) {
      daemonProcess.unref();
      console.log(`  Logs: ${daemonLogPath}`);
    }

    // Wait a moment for daemon to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const daemonCheck = isDaemonRunning();
    if (daemonCheck.running) {
      console.log(`✓ Daemon started (PID ${daemonCheck.pid})`);
    } else {
      console.error("✗ Failed to start daemon");
      console.error("  Run with --foreground to see error output");
      process.exit(1);
    }
  } else if (shouldStartDaemon) {
    console.log(`✓ Daemon already running (PID ${daemon.pid})`);
  }

  // Start server if requested and not running
  if (shouldStartServer && !server.running) {
    console.log("Starting server...");

    // Set up log file redirection for detached mode
    const serverLogPath = join(DATA_DIR, "server.log");
    const stdio = detached
      ? ["ignore", openSync(serverLogPath, "a"), openSync(serverLogPath, "a")]
      : "inherit";

    const serverProcess = spawn(process.execPath, [join(ROOT, "server.js")], {
      detached,
      stdio,
      env: { ...process.env, KATULONG_DATA_DIR: DATA_DIR },
    });

    if (detached) {
      serverProcess.unref();
      console.log(`  Logs: ${serverLogPath}`);
    }

    // Wait a moment for server to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const serverCheck = isServerRunning();
    if (serverCheck.running) {
      console.log(`✓ Server started (PID ${serverCheck.pid})`);
    } else {
      console.error("✗ Failed to start server");
      console.error("  Run with --foreground to see error output");
      process.exit(1);
    }
  } else if (shouldStartServer) {
    console.log(`✓ Server already running (PID ${server.pid})`);
  }

  // Show access information
  const port = process.env.PORT || 3001;
  console.log(`\n✓ Katulong is running`);
  console.log(`  Open: http://localhost:${port}`);
  console.log(`\nRun 'katulong logs' to view output`);
  console.log(`Run 'katulong stop' to stop all processes`);
}
