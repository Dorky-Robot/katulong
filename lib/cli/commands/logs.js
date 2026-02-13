import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../process-manager.js";

export default async function logs(args) {
  const target = args[0] || "both"; // daemon, server, or both
  const follow = !args.includes("--no-follow");

  const daemonLog = join(DATA_DIR, "daemon.log");
  const serverLog = join(DATA_DIR, "server.log");

  // Validate target
  if (!["daemon", "server", "both"].includes(target)) {
    console.error(`Error: Invalid target '${target}'`);
    console.error("Usage: katulong logs [daemon|server|both] [--no-follow]");
    process.exit(1);
  }

  // Check if log files exist
  const logsExist = {
    daemon: existsSync(daemonLog),
    server: existsSync(serverLog),
  };

  if (target === "daemon" && !logsExist.daemon) {
    console.error("Error: Daemon log file does not exist");
    console.error(`  Expected: ${daemonLog}`);
    console.error("\nHint: Logs are only created when processes run in background mode");
    console.error("      Start with 'katulong start' to enable logging");
    process.exit(1);
  }

  if (target === "server" && !logsExist.server) {
    console.error("Error: Server log file does not exist");
    console.error(`  Expected: ${serverLog}`);
    process.exit(1);
  }

  if (target === "both" && !logsExist.daemon && !logsExist.server) {
    console.error("Error: No log files exist");
    console.error("Hint: Start Katulong with 'katulong start' to enable logging");
    process.exit(1);
  }

  // Stream logs
  const tailArgs = follow ? ["-f"] : [];

  if (target === "daemon" || (target === "both" && logsExist.daemon)) {
    console.log("==> daemon.log <==\n");
    const tail = spawn("tail", [...tailArgs, "-n", "50", daemonLog], {
      stdio: "inherit",
    });
    tail.on("error", (err) => {
      console.error(`Failed to tail daemon log: ${err.message}`);
    });
    if (!follow) await new Promise((resolve) => tail.on("close", resolve));
  }

  if (target === "server" || (target === "both" && logsExist.server)) {
    if (target === "both") console.log("\n==> server.log <==\n");
    const tail = spawn("tail", [...tailArgs, "-n", "50", serverLog], {
      stdio: "inherit",
    });
    tail.on("error", (err) => {
      console.error(`Failed to tail server log: ${err.message}`);
    });
    if (!follow) await new Promise((resolve) => tail.on("close", resolve));
  }

  // If following both logs, keep process alive
  if (follow && target === "both") {
    await new Promise(() => {}); // Never resolves
  }
}
