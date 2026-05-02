/**
 * CLI: katulong bridge <name> <action>
 *
 * Manages local-service bridges (e.g., ollama-bridge) defined in
 * `katulong/bridges/<name>/manifest.js`. Each bridge runs as its own
 * launchd job so a bridge crash doesn't take down the terminal.
 */

import { execSync, execFileSync } from "node:child_process";
import {
  existsSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { listBridges, getBridge } from "../../../bridges/_lib/registry.js";
import {
  resolveBridge,
  writeBridgeConfig,
  loadBridgeConfig,
  generateToken,
} from "../../../bridges/_lib/config-loader.js";
import { startBridgeServer } from "../../../bridges/_lib/server.js";
import { createRotatingLogger } from "../../../bridges/_lib/rotating-logger.js";
import {
  bridgeLabel,
  bridgePlistPath,
  buildBridgePlist,
} from "../../../bridges/_lib/launchd-template.js";
import { DATA_DIR } from "../process-manager.js";

function bridgeLogDir(bridgeName) {
  return `${DATA_DIR}/bridges/${bridgeName}/logs`;
}

function usage() {
  console.log(`
Usage: katulong bridge <command> [args]

Commands:
  list                          List available bridges
  <name> start                  Run a bridge in the foreground (used by launchd)
  <name> new-token              Mint a fresh 32-byte hex token and save it
  <name> show-token             Print the saved token (for copying to other devices)
  <name> install                Write + load the LaunchAgent plist
  <name> uninstall              Unload + remove the LaunchAgent plist
  <name> status                 Report whether the bridge is loaded and listening
`);
}

// Hardcoded set of acceptable katulong install prefixes — guards against
// PATH-hijack baking a malicious binary into the launchd plist. If `which`
// returns something outside this set, fall back to process.argv[1] (the
// running CLI's own path) which is the most authoritative source.
const TRUSTED_BIN_PREFIXES = [
  "/opt/homebrew/",
  "/usr/local/",
  "/usr/bin/",
  "/bin/",
];

const PROBE_TIMEOUT_MS = 1000;

function resolveKatulongBin() {
  // Prefer the currently-executing CLI's own path — that's the same
  // binary the operator just used to invoke this command, so it cannot
  // be PATH-hijacked between now and the plist load.
  if (process.argv[1] && existsSync(process.argv[1])) {
    return process.argv[1];
  }
  try {
    const resolved = execSync("which katulong", { encoding: "utf-8" }).trim();
    if (resolved && TRUSTED_BIN_PREFIXES.some((p) => resolved.startsWith(p))) {
      return resolved;
    }
  } catch { /* which not found */ }
  return "/opt/homebrew/bin/katulong";
}

function ensureMacOS(action) {
  if (process.platform !== "darwin") {
    console.error(
      `\`katulong bridge ${action}\` is only supported on macOS (uses launchd).\n` +
        `On other platforms, run the bridge directly:\n` +
        `  katulong bridge <name> start\n` +
        `…or wrap it in your init system of choice.`,
    );
    process.exit(2);
  }
}

async function actionList() {
  const bridges = await listBridges();
  if (bridges.length === 0) {
    console.log("No bridges defined.");
    return;
  }
  for (const b of bridges) {
    const config = loadBridgeConfig(DATA_DIR, b.name) || {};
    const tokenState = config.token ? "configured" : "no token";
    console.log(`  ${b.name.padEnd(12)} :${b.port}  → ${b.target}  [${tokenState}]`);
    if (b.description) console.log(`  ${" ".repeat(12)} ${b.description}`);
  }
}

async function actionStart(name) {
  const manifest = await getBridge(name);
  const resolved = resolveBridge({ manifest, dataDir: DATA_DIR });
  const logger = createRotatingLogger({ dir: bridgeLogDir(manifest.name) });
  await startBridgeServer({ ...resolved, logger });
  console.log(
    `katulong bridge ${name}: listening on ${resolved.bind}:${resolved.port}, ` +
      `forwarding to ${resolved.target}`,
  );
  // Don't return — bridge process stays alive until killed.
}

async function actionNewToken(name) {
  const manifest = await getBridge(name);
  const token = generateToken();
  writeBridgeConfig(DATA_DIR, manifest.name, { token });
  console.log(`Token saved for bridge "${manifest.name}".\n`);
  console.log(`  ${token}\n`);
  console.log(
    "Copy this token into the consumer (e.g., katulong settings → " +
      "External LLM endpoint) — it will not be shown again unless you ask " +
      `with: katulong bridge ${manifest.name} show-token`,
  );
}

async function actionShowToken(name) {
  const manifest = await getBridge(name);
  const config = loadBridgeConfig(DATA_DIR, manifest.name);
  if (!config?.token) {
    console.error(
      `bridge "${manifest.name}" has no token. ` +
        `Run: katulong bridge ${manifest.name} new-token`,
    );
    process.exit(1);
  }
  console.log(config.token);
}

async function actionInstall(name) {
  ensureMacOS("install");
  const manifest = await getBridge(name);
  const config = loadBridgeConfig(DATA_DIR, manifest.name);
  if (!config?.token) {
    console.error(
      `bridge "${manifest.name}" has no token configured. ` +
        `Run this first: katulong bridge ${manifest.name} new-token`,
    );
    process.exit(1);
  }

  const plistPath = bridgePlistPath(manifest.name);
  if (existsSync(plistPath)) {
    console.error(
      `LaunchAgent already exists at ${plistPath}\n` +
        `Run 'katulong bridge ${manifest.name} uninstall' first to reinstall.`,
    );
    process.exit(1);
  }

  // Make sure the log directory exists before launchd tries to write to it.
  mkdirSync(`${DATA_DIR}/bridges/${manifest.name}`, { recursive: true });

  const xml = buildBridgePlist({
    bridgeName: manifest.name,
    bin: resolveKatulongBin(),
    dataDir: DATA_DIR,
  });
  // Atomic temp + rename — same posture as service.js's plist writes.
  const tmpPath = plistPath + ".tmp";
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(tmpPath, xml, { mode: 0o644 });
  renameSync(tmpPath, plistPath);
  console.log(`✓ Wrote ${plistPath}`);

  try {
    // execFileSync (not execSync) — argv array, no shell, no metachar
    // expansion. Bridge name is allowlisted in the registry, but this is
    // defense in depth.
    execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
    console.log(`✓ ${bridgeLabel(manifest.name)} loaded and enabled`);
  } catch {
    console.error(
      `launchctl load failed. The plist is on disk; you can retry with:\n` +
        `  launchctl load -w "${plistPath}"`,
    );
    process.exit(1);
  }
}

async function actionUninstall(name) {
  ensureMacOS("uninstall");
  const manifest = await getBridge(name);
  const plistPath = bridgePlistPath(manifest.name);
  if (!existsSync(plistPath)) {
    console.log(`No LaunchAgent at ${plistPath}, nothing to uninstall.`);
    return;
  }
  try {
    execFileSync("launchctl", ["unload", "-w", plistPath], { stdio: "pipe" });
  } catch { /* may already be unloaded */ }
  unlinkSync(plistPath);
  console.log(`✓ Removed ${plistPath}`);
}

async function actionStatus(name) {
  ensureMacOS("status");
  const manifest = await getBridge(name);
  const label = bridgeLabel(manifest.name);
  const plistPath = bridgePlistPath(manifest.name);
  const config = loadBridgeConfig(DATA_DIR, manifest.name);

  console.log(`Bridge: ${manifest.name}`);
  console.log(`  Plist:    ${existsSync(plistPath) ? plistPath : "(not installed)"}`);
  console.log(`  Token:    ${config?.token ? "configured" : "(not set)"}`);
  console.log(`  Default:  port ${manifest.port}, target ${manifest.target}`);

  let loaded = false;
  let pid = null;
  try {
    // The label is constructed from the (allowlisted) bridge name; still
    // pass via argv so even a future name-validator regression doesn't
    // become shell injection.
    const out = execFileSync("launchctl", ["list", label], { encoding: "utf-8" });
    loaded = true;
    const m = out.match(/"PID"\s*=\s*(\d+);/);
    if (m) pid = Number(m[1]);
  } catch { /* not loaded */ }
  console.log(`  Launchd:  ${loaded ? `loaded${pid ? ` (PID ${pid})` : ""}` : "not loaded"}`);

  // Live-port probe — a quick sanity check the bridge is actually listening
  // on the resolved port. Skips if the token is missing (resolveBridge throws).
  if (config?.token) {
    try {
      const resolved = resolveBridge({ manifest, dataDir: DATA_DIR });
      const reachable = await probeLocalPort(resolved.port, PROBE_TIMEOUT_MS);
      console.log(`  Listening: ${reachable ? `yes (port ${resolved.port})` : "no"}`);
    } catch { /* config invalid */ }
  }
}

async function probeLocalPort(port, timeoutMs) {
  // Tiny TCP-connect check; a hit-and-run that doesn't speak HTTP at all.
  const { Socket } = await import("node:net");
  return new Promise((resolve) => {
    const sock = new Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, "127.0.0.1");
  });
}

const TOP_LEVEL = { list: actionList };
const PER_BRIDGE = {
  start: actionStart,
  "new-token": actionNewToken,
  "show-token": actionShowToken,
  install: actionInstall,
  uninstall: actionUninstall,
  status: actionStatus,
};

export default async function bridge(args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    usage();
    process.exit(args.length ? 0 : 1);
  }

  // First-level dispatch: `katulong bridge list`
  if (TOP_LEVEL[args[0]]) {
    await TOP_LEVEL[args[0]](args.slice(1));
    return;
  }

  // Second-level dispatch: `katulong bridge <name> <action>`
  const [name, action] = args;
  if (!action) {
    console.error(`Missing action. Run: katulong bridge ${name} --help`);
    usage();
    process.exit(1);
  }
  const handler = PER_BRIDGE[action];
  if (!handler) {
    console.error(`Unknown action "${action}" for bridge "${name}".`);
    usage();
    process.exit(1);
  }
  await handler(name);
}
