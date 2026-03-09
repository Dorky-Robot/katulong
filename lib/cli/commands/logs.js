import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../process-manager.js";

export default async function logs(args) {
  const follow = !args.includes("--no-follow");
  const serverLog = join(DATA_DIR, "server.log");

  if (!existsSync(serverLog)) {
    console.error("Error: Log file does not exist");
    console.error(`  Expected: ${serverLog}`);
    console.error("\nHint: Logs are only created when running in background mode");
    console.error("      Start with 'katulong start' to enable logging");
    process.exit(1);
  }

  const tailArgs = follow ? ["-f"] : [];
  const tail = spawn("tail", [...tailArgs, "-n", "50", serverLog], {
    stdio: "inherit",
  });
  tail.on("error", (err) => {
    console.error(`Failed to tail log: ${err.message}`);
  });
  if (!follow) await new Promise((resolve) => tail.on("close", resolve));
}
