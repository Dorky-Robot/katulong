import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import envConfig from "../../env-config.js";

const PLIST_LABEL = "com.dorkyrobot.katulong";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`);

function katulongBin() {
  // Resolve the canonical path to the katulong binary.
  // For Homebrew this follows the symlink in /opt/homebrew/bin/katulong,
  // so after `brew upgrade` the service picks up the new version on restart.
  try {
    return execSync("which katulong", { encoding: "utf-8" }).trim();
  } catch {
    return "/opt/homebrew/bin/katulong";
  }
}

function buildPlist() {
  const bin = katulongBin();
  const port = envConfig.port;
  const dataDir = envConfig.dataDir;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${port}</string>
    <key>KATULONG_DATA_DIR</key>
    <string>${dataDir}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${dataDir}/launchd-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${dataDir}/launchd-stderr.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>`;
}

function isLoaded() {
  try {
    const out = execSync(`launchctl list ${PLIST_LABEL} 2>&1`, {
      encoding: "utf-8",
    });
    return !out.includes("Could not find service");
  } catch {
    return false;
  }
}

function install() {
  if (process.platform !== "darwin") {
    console.error("✗ Service management is only supported on macOS");
    process.exit(1);
  }

  if (existsSync(PLIST_PATH)) {
    console.log(`Service plist already exists at ${PLIST_PATH}`);
    console.log("Run 'katulong service uninstall' first to reinstall.");
    return;
  }

  const plist = buildPlist();
  writeFileSync(PLIST_PATH, plist, { mode: 0o644 });
  console.log(`✓ Wrote ${PLIST_PATH}`);

  try {
    execSync(`launchctl load -w ${PLIST_PATH}`, { stdio: "inherit" });
    console.log("✓ Service loaded and enabled");
  } catch {
    console.error("✗ Failed to load service — try manually:");
    console.error(`  launchctl load -w ${PLIST_PATH}`);
    process.exit(1);
  }

  console.log("\nKatulong will now start automatically on login.");
  console.log("After 'brew upgrade katulong', restart the service:");
  console.log("  katulong service restart");
}

function uninstall() {
  if (isLoaded()) {
    try {
      execSync(`launchctl unload -w ${PLIST_PATH}`, { stdio: "inherit" });
      console.log("✓ Service unloaded");
    } catch {
      console.error("✗ Failed to unload service");
    }
  }

  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
    console.log(`✓ Removed ${PLIST_PATH}`);
  } else {
    console.log("No service plist found — nothing to remove.");
    return;
  }

  console.log("\nKatulong will no longer start automatically.");
}

function restart() {
  if (!existsSync(PLIST_PATH)) {
    console.error("✗ Service not installed. Run 'katulong service install' first.");
    process.exit(1);
  }

  console.log("Restarting service...\n");

  if (isLoaded()) {
    try {
      execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
    } catch {
      // may already be unloaded
    }
  }

  try {
    execSync(`launchctl load -w ${PLIST_PATH}`, { stdio: "inherit" });
    console.log("✓ Service restarted");
  } catch {
    console.error("✗ Failed to reload service");
    process.exit(1);
  }
}

function status() {
  if (!existsSync(PLIST_PATH)) {
    console.log("✗ Service not installed");
    console.log("\nRun 'katulong service install' to enable auto-start on login.");
    return;
  }

  console.log(`Plist: ${PLIST_PATH}`);

  if (isLoaded()) {
    console.log("✓ Service is loaded and enabled");
    try {
      const out = execSync(`launchctl list ${PLIST_LABEL}`, {
        encoding: "utf-8",
      });
      // Extract PID and last exit status
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      const exitMatch = out.match(/"LastExitStatus"\s*=\s*(\d+)/);
      if (pidMatch) console.log(`  PID: ${pidMatch[1]}`);
      if (exitMatch) console.log(`  Last exit status: ${exitMatch[1]}`);
    } catch {
      // list may fail if not loaded
    }
  } else {
    console.log("✗ Service is not loaded");
  }

  // Show what binary the plist points to
  try {
    const plist = readFileSync(PLIST_PATH, "utf-8");
    const binMatch = plist.match(
      /<array>\s*<string>([^<]+)<\/string>/,
    );
    if (binMatch) {
      console.log(`  Binary: ${binMatch[1]}`);
    }
  } catch {
    // ignore
  }
}

const SUBCOMMANDS = {
  install: "Install macOS LaunchAgent for auto-start on login",
  uninstall: "Remove LaunchAgent and disable auto-start",
  restart: "Restart the LaunchAgent service",
  status: "Show whether the LaunchAgent is installed and loaded",
};

function showHelp() {
  console.log(`
katulong service — Manage the macOS LaunchAgent

USAGE:
  katulong service <subcommand>

SUBCOMMANDS:
${Object.entries(SUBCOMMANDS)
  .map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
  .join("\n")}

EXAMPLES:
  katulong service install     Enable auto-start on login
  katulong service uninstall   Disable auto-start
  katulong service restart     Restart after brew upgrade
  katulong service status      Check if service is installed
`);
}

export default async function service(args) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    showHelp();
    return;
  }

  switch (sub) {
    case "install":
      install();
      break;
    case "uninstall":
      uninstall();
      break;
    case "restart":
      restart();
      break;
    case "status":
      status();
      break;
    default:
      console.error(`Unknown subcommand '${sub}'`);
      showHelp();
      process.exit(1);
  }
}
