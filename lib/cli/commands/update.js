import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  detectInstallMethod,
  isServerRunning,
  ROOT,
  DATA_DIR,
} from "../process-manager.js";

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
 * Resolve the new binary path so we can re-exec it.
 */
function resolveNewBinary() {
  try {
    const bin = execSync("which katulong", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    // Verify it actually resolves
    realpathSync(bin);
    return bin;
  } catch {
    return null;
  }
}

function resolveInstalledRoot() {
  try {
    const bin = resolveNewBinary();
    if (!bin) return ROOT;
    const real = realpathSync(bin);
    // real → .../libexec/bin/katulong — go up one level to libexec/
    // (where package.json and server.js live)
    return join(dirname(real), "..");
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

function cleanupSentinel() {
  try { unlinkSync(SENTINEL_PATH); } catch {}
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

  // Create sentinel so brew post_install skips its own restart —
  // we'll handle it ourselves via _finish-upgrade after brew is done.
  try {
    writeFileSync(SENTINEL_PATH, String(Date.now()));
  } catch {
    // non-fatal
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
  } catch {
    cleanupSentinel();
    console.error(`\n✗ Update failed`);
    process.exit(1);
  }

  // Resolve the new version
  const newRoot = method === "homebrew" ? resolveInstalledRoot() : ROOT;
  const newVersion = readVersion(newRoot);

  if (currentVersion === newVersion) {
    console.log(`\n✓ Already up to date (v${newVersion})`);
    cleanupSentinel();
    return;
  }

  console.log(`\n✓ Updated: v${currentVersion} -> v${newVersion}`);

  if (noRestart) {
    console.log("Skipping restart (--no-restart)");
    cleanupSentinel();
    return;
  }

  if (!oldServer.running) {
    console.log(`\nNo running server. Start with: katulong start`);
    cleanupSentinel();
    return;
  }

  // Hand off to the NEW binary for the smoke-test-and-swap.
  // This is critical: the current process is the OLD binary (pre-upgrade).
  // The new binary has the latest _finish-upgrade code.
  const newBin = resolveNewBinary();
  if (newBin) {
    console.log("");
    try {
      execSync(
        `"${newBin}" _finish-upgrade --old-pid ${oldPid}`,
        { stdio: "inherit", encoding: "utf-8" },
      );
    } catch {
      cleanupSentinel();
      console.error("\n✗ Post-upgrade restart failed");
      console.error("  Try: katulong start");
      process.exit(1);
    }
  } else {
    // Fallback: can't resolve new binary, try inline restart
    cleanupSentinel();
    console.log("\nRestarting server...");
    const restart = (await import("./restart.js")).default;
    await restart(["--rolling"]);
  }
}

async function checkForUpdate(method) {
  console.log("Checking for updates...\n");

  try {
    switch (method) {
      case "homebrew":
        try {
          execQuiet("brew update --quiet");
        } catch {}
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
  } catch {
    console.error("Check failed: could not reach remote");
    process.exit(1);
  }
}
