/**
 * Hidden command invoked by `katulong update` after brew upgrade.
 *
 * The OLD binary runs `brew upgrade`, which installs the NEW binary.
 * The OLD binary then re-execs the NEW binary with `_finish-upgrade`
 * so the new code handles the smoke test and service swap.
 *
 * Usage (internal only):
 *   katulong _finish-upgrade --old-pid <PID> --port <PORT>
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  isServerRunning,
  isProcessRunning,
  ROOT,
  DATA_DIR,
} from "../process-manager.js";
import envConfig from "../../env-config.js";

const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents/com.dorkyrobot.katulong.plist",
);

const SENTINEL_PATH = join(DATA_DIR, ".update-in-progress");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function killProcess(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function waitForHealth(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ok") return data;
      }
    } catch {
      // not ready yet
    }
    await sleep(300);
  }
  return null;
}

async function stopOldServer(pid) {
  if (!pid) return;

  killProcess(pid, "SIGTERM");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessRunning(pid)) {
    await sleep(200);
  }

  if (isProcessRunning(pid)) {
    console.log(`  Old server (PID ${pid}) did not exit, sending SIGKILL...`);
    killProcess(pid, "SIGKILL");
    await sleep(500);
  }
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

export default async function finishUpgrade(args) {
  const port = envConfig.port;
  const newVersion = readVersion();

  // Parse --old-pid flag
  let oldPid = null;
  const pidIdx = args.indexOf("--old-pid");
  if (pidIdx !== -1 && args[pidIdx + 1]) {
    oldPid = parseInt(args[pidIdx + 1], 10);
    if (isNaN(oldPid) || !isProcessRunning(oldPid)) oldPid = null;
  }

  // Fall back to checking what's running
  if (!oldPid) {
    const server = isServerRunning();
    if (server.running) oldPid = server.pid;
  }

  // --- Smoke test on a temp port ---
  const testPort = await findFreePort();
  console.log(
    `Smoke testing v${newVersion} on port ${testPort}...`,
  );

  const logPath = join(DATA_DIR, "smoke-test.log");
  const testProc = spawn(process.execPath, [join(ROOT, "server.js")], {
    detached: true,
    stdio: ["ignore", openSync(logPath, "w"), openSync(logPath, "w")],
    env: {
      ...process.env,
      PORT: String(testPort),
      KATULONG_DATA_DIR: DATA_DIR,
    },
  });
  testProc.unref();

  const health = await waitForHealth(testPort, 10000);

  // Always kill the smoke test server
  killProcess(testProc.pid, "SIGKILL");
  await sleep(300);

  if (!health) {
    console.error("✗ Smoke test failed — new server did not become healthy");
    console.error(`  Check logs: ${logPath}`);
    if (oldPid) {
      console.error("  Old server is still running, no changes made.");
    }
    process.exit(1);
  }

  console.log(`✓ Smoke test passed (v${health.version})`);

  // --- Stop old server ---
  if (oldPid) {
    console.log(`Stopping old server (PID ${oldPid})...`);
    await stopOldServer(oldPid);
  }

  // --- Start new server on the real port ---
  if (existsSync(PLIST_PATH)) {
    console.log("Starting via LaunchAgent...");
    const { buildAndWritePlist, launchctlUnload, launchctlLoad } = await import(
      "./service.js"
    );
    // Ensure service is fully unloaded before reloading
    try {
      launchctlUnload();
    } catch {}
    buildAndWritePlist();
    try {
      launchctlLoad();
    } catch {
      console.error("✗ launchctl load failed — try: katulong service restart");
      process.exit(1);
    }
  } else {
    console.log("Starting new server...");
    const serverLogPath = join(DATA_DIR, "server.log");
    spawn(process.execPath, [join(ROOT, "server.js")], {
      detached: true,
      stdio: [
        "ignore",
        openSync(serverLogPath, "a"),
        openSync(serverLogPath, "a"),
      ],
      env: {
        ...process.env,
        PORT: String(port),
        KATULONG_DATA_DIR: DATA_DIR,
      },
    }).unref();
  }

  // --- Verify ---
  const finalHealth = await waitForHealth(port, 10000);
  if (!finalHealth) {
    console.error(`✗ New server failed to start on port ${port}`);
    console.error("  Try: katulong start");
    process.exit(1);
  }

  console.log(`✓ Running v${finalHealth.version} (PID ${finalHealth.pid})`);
  console.log(`  Open: http://localhost:${port}`);

  // Clean up sentinel
  try {
    unlinkSync(SENTINEL_PATH);
  } catch {}
}
