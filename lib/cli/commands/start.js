import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { openSync } from "node:fs";
import { isServerRunning, ROOT, DATA_DIR } from "../process-manager.js";
import { join } from "node:path";
import envConfig from "../../env-config.js";

function waitForHttp(port, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      if (Date.now() > deadline) return reject(new Error("timeout"));
      const probe = createConnection(port, "127.0.0.1");
      probe.on("connect", () => { probe.destroy(); resolve(); });
      probe.on("error", () => setTimeout(attempt, 100));
    }
    attempt();
  });
}

export default async function start(args) {
  const detached = !args.includes("--foreground");

  const server = isServerRunning();

  if (server.running) {
    console.log("Katulong is already running");
    console.log(`  Server: PID ${server.pid}`);
    console.log("\nRun 'katulong status' for more information");
    return;
  }

  console.log("Starting Katulong...\n");

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

  // Wait for server to accept connections
  try {
    await waitForHttp(envConfig.port);
  } catch {
    console.error("✗ Failed to start server (not accepting connections)");
    console.error("  Run with --foreground to see error output");
    process.exit(1);
  }

  const serverCheck = isServerRunning();
  if (serverCheck.running) {
    console.log(`✓ Server started (PID ${serverCheck.pid})`);
  } else {
    console.error("✗ Failed to start server");
    console.error("  Run with --foreground to see error output");
    process.exit(1);
  }

  // Show access information
  const port = envConfig.port;
  console.log(`\n✓ Katulong is running`);
  console.log(`  Open: http://localhost:${port}`);
  console.log(`\nRun 'katulong logs' to view output`);
  console.log(`Run 'katulong stop' to stop`);
}
