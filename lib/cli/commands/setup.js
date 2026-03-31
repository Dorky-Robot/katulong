/**
 * CLI: katulong setup <subcommand>
 *
 * One-time setup helpers for katulong features.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureRunning, api } from "../api-client.js";

const KATULONG_DIR = join(homedir(), ".katulong");
const REMOTE_PATH = join(KATULONG_DIR, "remote.json");

function usage() {
  console.log(`
Usage: katulong setup <subcommand>

Subcommands:
  self-access       Create remote.json so other contexts (kubos, agents) can reach this instance
`);
}

async function selfAccess(args) {
  const force = args.includes("--force");

  if (existsSync(REMOTE_PATH) && !force) {
    const existing = JSON.parse(readFileSync(REMOTE_PATH, "utf-8"));
    console.error(`Self-access already configured at ${REMOTE_PATH}`);
    console.error(`  URL: ${existing.url}`);
    console.error(`  Key: ${existing.apiKey?.slice(0, 8)}...`);
    console.error(`\nUse --force to replace it.`);
    process.exit(1);
  }

  ensureRunning();

  // Get the instance's public URL
  const { url } = await api.get("/api/external-url");
  if (!url) {
    console.error("No external URL configured for this instance.");
    console.error("Set up a Cloudflare tunnel or configure the external URL first.");
    process.exit(1);
  }

  // Create an API key
  const keyData = await api.post("/api/api-keys", { name: "self-access" });

  // Write discovery file
  mkdirSync(KATULONG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(REMOTE_PATH, JSON.stringify({ url, apiKey: keyData.key }, null, 2) + "\n", { mode: 0o600 });

  console.log(`Self-access configured.`);
  console.log(`  File: ${REMOTE_PATH}`);
  console.log(`  URL:  ${url}`);
  console.log(`\nKubo containers will pick this up at /home/dev/.katulong/remote.json`);
}

const subcommands = { "self-access": selfAccess };

export default async function setup(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    usage();
    process.exit(sub ? 0 : 1);
  }

  if (!subcommands[sub]) {
    console.error(`Unknown subcommand: ${sub}`);
    usage();
    process.exit(1);
  }

  try {
    await subcommands[sub](args.slice(1));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
