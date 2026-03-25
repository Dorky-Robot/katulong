import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  detectInstallMethod,
  isServerRunning,
  ROOT,
} from "../process-manager.js";
import restart from "./restart.js";

const PLIST_PATH = join(
  homedir(),
  "Library/LaunchAgents/com.dorkyrobot.katulong.plist",
);

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read version from the current Homebrew installation.
 * After `brew upgrade`, ROOT still points at the old (deleted) Cellar path,
 * so we ask Homebrew directly for the installed version.
 */
function readBrewVersion() {
  try {
    const info = execSync(
      "brew info --json=v2 dorky-robot/tap/katulong 2>/dev/null || brew info --json=v2 katulong",
      { encoding: "utf-8", stdio: "pipe" },
    );
    const data = JSON.parse(info);
    return data.formulae?.[0]?.installed?.[0]?.version || null;
  } catch {
    return null;
  }
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "inherit", ...opts });
}

function execQuiet(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
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

  // Snapshot server state before update — brew upgrade may kill the process
  const serverWasRunning = isServerRunning().running;

  // Run the appropriate update
  console.log("Updating...\n");

  try {
    switch (method) {
      case "homebrew":
        // Try tap-qualified name first (quiet), then fall back to short name
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
        // Check current branch — warn if not on main
        const branch = execQuiet(
          `git -C "${ROOT}" rev-parse --abbrev-ref HEAD`
        ).trim();
        if (branch !== "main") {
          console.log(
            `Warning: on branch '${branch}', fetching and rebasing onto origin/main\n`
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
    console.error(`\n✗ Update failed`);
    process.exit(1);
  }

  // Re-read version from the updated install.
  // For Homebrew, ROOT points at the old Cellar version which is removed
  // after upgrade, so read from the new Cellar/opt path instead.
  let newVersion;
  if (method === "homebrew") {
    newVersion = readBrewVersion() || readVersion();
  } else {
    newVersion = readVersion();
  }

  if (currentVersion === newVersion) {
    console.log(`\n✓ Already up to date (v${newVersion})`);
  } else {
    console.log(`\n✓ Updated: v${currentVersion} -> v${newVersion}`);
  }

  if (noRestart) {
    console.log("Skipping restart (--no-restart)");
    return;
  }

  // For Homebrew upgrades, post_install already handled the restart when a
  // LaunchAgent is present, so we only need to act if the server was managed
  // manually (no service) or for non-Homebrew install methods.
  if (method === "homebrew" && existsSync(PLIST_PATH)) {
    console.log("\n✓ LaunchAgent restarted by brew post_install");
    return;
  }

  // Check what's running and restart accordingly
  const wasRunning = isServerRunning().running;

  if (wasRunning) {
    console.log("\nServer is running, performing rolling restart...");
    await restart(["--rolling"]);
  } else if (serverWasRunning) {
    // Server was running before update but isn't now (e.g., brew upgrade
    // removed the old version). Start it back up.
    console.log("\nServer was stopped during update, starting...");
    const start = (await import("./start.js")).default;
    await start([]);
  } else {
    console.log(`\nNo running processes. Start with: katulong start`);
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
          // brew update may fail on network issues, continue to check installed version
        }
        try {
          const info = execQuiet(
            "brew info --json=v2 dorky-robot/tap/katulong 2>/dev/null || brew info --json=v2 katulong"
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
            "npm outdated -g katulong --json 2>/dev/null || echo {}"
          );
          const data = JSON.parse(outdated);
          if (data.katulong) {
            console.log(
              `Update available: v${data.katulong.current} -> v${data.katulong.latest}`
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
          `git -C "${ROOT}" rev-list HEAD..origin/main --count`
        ).trim();
        if (count !== "0") {
          console.log(
            `Update available: ${count} commit(s) behind origin/main`
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
