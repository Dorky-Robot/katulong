import { execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  detectInstallMethod,
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

function readVersion(root = ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * After brew upgrade, the symlink points to the new Cellar version.
 * Resolve the actual root of the newly installed package.
 */
function resolveInstalledRoot() {
  try {
    const bin = execSync("which katulong", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const real = realpathSync(bin);
    // real → .../libexec/bin/katulong → go up two levels to libexec/
    return join(dirname(real), "../..");
  } catch {
    return ROOT;
  }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "inherit", ...opts });
}

function execQuiet(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

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

/**
 * Start a server on the given port using the given root directory.
 * Returns the spawned child process.
 */
function startTestServer(root, port) {
  const logPath = join(DATA_DIR, "smoke-test.log");
  const stdio = [
    "ignore",
    openSync(logPath, "w"),
    openSync(logPath, "w"),
  ];

  const child = spawn(process.execPath, [join(root, "server.js")], {
    detached: true,
    stdio,
    env: {
      ...process.env,
      PORT: String(port),
      KATULONG_DATA_DIR: DATA_DIR,
    },
  });
  child.unref();
  return child;
}

/**
 * Poll /health on the given port until it returns status=ok.
 * Returns the health response or null on timeout.
 */
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

function killProcess(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Stop the old server, waiting for graceful exit then forcing if needed.
 */
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

/**
 * Smoke test the new version on a temp port, then swap it in.
 */
async function smokeTestAndSwap(newRoot, oldPid) {
  const port = envConfig.port;
  const testPort = await findFreePort();
  const newVersion = readVersion(newRoot);

  console.log(
    `\nSmoke testing new version (v${newVersion}) on port ${testPort}...`,
  );

  const testProc = startTestServer(newRoot, testPort);

  const health = await waitForHealth(testPort, 10000);

  // Always kill the test server
  killProcess(testProc.pid, "SIGKILL");
  // Wait for it to die
  await sleep(500);

  if (!health) {
    const logPath = join(DATA_DIR, "smoke-test.log");
    console.error("\n✗ Smoke test failed — new server did not become healthy");
    console.error(`  Check logs: ${logPath}`);
    if (oldPid) {
      console.error("  Old server is still running, no changes made.");
    }
    process.exit(1);
  }

  console.log(`✓ Smoke test passed (version: v${health.version})`);

  // Now stop old server and start new one on the real port
  if (oldPid) {
    console.log(`\nStopping old server (PID ${oldPid})...`);
    await stopOldServer(oldPid);
    console.log("  Old server stopped");
  }

  // Start the new server on the real port
  if (existsSync(PLIST_PATH)) {
    console.log("Restarting via LaunchAgent...");
    // Regenerate the plist so it points to the new binary
    const { buildAndWritePlist } = await import("./service.js");
    buildAndWritePlist();
    try {
      execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "inherit" });
    } catch {
      console.error("✗ launchctl load failed — try: katulong service restart");
      process.exit(1);
    }
  } else {
    console.log("Starting new server...");
    const serverLogPath = join(DATA_DIR, "server.log");
    const stdio = [
      "ignore",
      openSync(serverLogPath, "a"),
      openSync(serverLogPath, "a"),
    ];
    spawn(process.execPath, [join(newRoot, "server.js")], {
      detached: true,
      stdio,
      env: { ...process.env, PORT: String(port), KATULONG_DATA_DIR: DATA_DIR },
    }).unref();
  }

  // Verify the new server is healthy on the real port
  const finalHealth = await waitForHealth(port, 10000);
  if (!finalHealth) {
    console.error("\n✗ New server failed to start on port " + port);
    console.error("  Try: katulong start");
    process.exit(1);
  }

  console.log(`\n✓ Running v${finalHealth.version} (PID ${finalHealth.pid})`);
  console.log(`  Open: http://localhost:${port}`);
}

export default async function update(args) {
  // Reject unexpected positional arguments
  const positional = args.find((arg) => !arg.startsWith("--"));
  if (positional) {
    console.error(`Error: Unexpected argument '${positional}'`);
    console.error("Usage: katulong update [--check] [--no-restart]");
    process.exit(1);
  }

  const checkOnly = args.includes("--check");
  const noRestart = args.includes("--no-restart");
  const method = detectInstallMethod();
  const currentVersion = readVersion();

  const methodLabels = {
    homebrew: "Homebrew",
    "npm-global": "npm (global)",
    git: "git (manual install)",
    dev: "git (development)",
  };
  console.log(`Install method: ${methodLabels[method] || method}`);
  console.log(`Current version: v${currentVersion}\n`);

  if (checkOnly) {
    await checkForUpdate(method);
    return;
  }

  // Capture old server state before upgrading
  const oldServer = isServerRunning();
  const oldPid = oldServer.running ? oldServer.pid : null;

  // Create sentinel so brew post_install skips restart
  try {
    writeFileSync(SENTINEL_PATH, String(Date.now()));
  } catch {
    // non-fatal — post_install will just restart as before
  }

  // Run the appropriate update
  console.log("Updating...\n");

  try {
    switch (method) {
      case "homebrew":
        try {
          exec("brew upgrade dorky-robot/tap/katulong");
        } catch {
          exec("brew upgrade katulong");
        }
        break;

      case "npm-global":
        exec("npm update -g katulong");
        break;

      case "git":
      case "dev": {
        const branch = execQuiet(
          `git -C "${ROOT}" rev-parse --abbrev-ref HEAD`,
        ).trim();
        if (branch !== "main") {
          console.log(
            `Warning: on branch '${branch}', fetching and rebasing onto origin/main\n`,
          );
          exec(`git -C "${ROOT}" fetch origin main`);
          exec(`git -C "${ROOT}" rebase origin/main`);
        } else {
          exec(`git -C "${ROOT}" pull --ff-only origin main`);
        }
        exec(`npm install --prefix "${ROOT}"`);
        break;
      }
    }
  } catch (err) {
    // Clean up sentinel on failure
    try {
      unlinkSync(SENTINEL_PATH);
    } catch {}
    console.error(`\n✗ Update failed`);
    process.exit(1);
  }

  // Resolve the root of the newly installed version
  const newRoot = method === "homebrew" ? resolveInstalledRoot() : ROOT;
  const newVersion = readVersion(newRoot);

  if (currentVersion === newVersion) {
    console.log(`\n✓ Already up to date (v${newVersion})`);
    try {
      unlinkSync(SENTINEL_PATH);
    } catch {}
    return;
  }

  console.log(`\n✓ Updated: v${currentVersion} -> v${newVersion}`);

  if (noRestart) {
    console.log("Skipping restart (--no-restart)");
    try {
      unlinkSync(SENTINEL_PATH);
    } catch {}
    return;
  }

  if (!oldServer.running) {
    console.log(`\nNo running server. Start with: katulong start`);
    try {
      unlinkSync(SENTINEL_PATH);
    } catch {}
    return;
  }

  // Smoke test new version on a temp port, then swap
  try {
    await smokeTestAndSwap(newRoot, oldPid);
  } finally {
    try {
      unlinkSync(SENTINEL_PATH);
    } catch {}
  }
}

async function checkForUpdate(method) {
  console.log("Checking for updates...\n");

  try {
    switch (method) {
      case "homebrew":
        try {
          execQuiet("brew update --quiet");
        } catch {
          // brew update may fail on network issues
        }
        try {
          const info = execQuiet(
            'brew info --json=v2 dorky-robot/tap/katulong 2>/dev/null || brew info --json=v2 katulong',
          );
          const data = JSON.parse(info);
          const formula = data.formulae?.[0];
          if (formula) {
            const latest = formula.versions?.stable;
            const installed = formula.installed?.[0]?.version;
            if (latest && installed && latest !== installed) {
              console.log(`Update available: v${installed} -> v${latest}`);
              console.log("Run 'katulong update' to install");
            } else {
              console.log("Already up to date");
            }
          }
        } catch {
          console.log("Could not determine latest Homebrew version");
        }
        break;

      case "npm-global":
        try {
          const outdated = execQuiet(
            "npm outdated -g katulong --json 2>/dev/null || echo {}",
          );
          const data = JSON.parse(outdated);
          if (data.katulong) {
            console.log(
              `Update available: v${data.katulong.current} -> v${data.katulong.latest}`,
            );
            console.log("Run 'katulong update' to install");
          } else {
            console.log("Already up to date");
          }
        } catch {
          console.log("Could not determine latest npm version");
        }
        break;

      case "git":
      case "dev": {
        execQuiet(`git -C "${ROOT}" fetch origin main`);
        const count = execQuiet(
          `git -C "${ROOT}" rev-list HEAD..origin/main --count`,
        ).trim();
        if (count !== "0") {
          console.log(
            `Update available: ${count} commit(s) behind origin/main`,
          );
          console.log("Run 'katulong update' to install");
        } else {
          console.log("Already up to date");
        }
        break;
      }
    }
  } catch (err) {
    console.error("Check failed: could not reach remote");
    process.exit(1);
  }
}
