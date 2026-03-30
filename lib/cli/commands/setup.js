/**
 * CLI: katulong setup <subcommand>
 *
 * One-time setup helpers for katulong features.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureRunning, api } from "../api-client.js";

const CREDENTIALS_DIR = join(homedir(), ".katulong", "credentials");
const API_KEY_PATH = join(CREDENTIALS_DIR, "orchestrator-api-key");

function usage() {
  console.log(`
Usage: katulong setup <subcommand>

Subcommands:
  api             Create an orchestrator API key and save it to ~/.katulong/credentials/
`);
}

async function apiSetup(args) {
  const force = args.includes("--force");

  if (existsSync(API_KEY_PATH) && !force) {
    const existing = readFileSync(API_KEY_PATH, "utf-8").trim();
    console.error(`Orchestrator API key already exists at ${API_KEY_PATH}`);
    console.error(`  Key prefix: ${existing.slice(0, 8)}...`);
    console.error(`\nUse --force to replace it.`);
    process.exit(1);
  }

  ensureRunning();
  const data = await api.post("/api/api-keys", { name: "orchestrator" });

  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(API_KEY_PATH, data.key + "\n", { mode: 0o600 });
  chmodSync(CREDENTIALS_DIR, 0o700);

  console.log(`Orchestrator API key created and saved.`);
  console.log(`  Path: ${API_KEY_PATH}`);
  console.log(`  Key:  ${data.key}`);
  console.log(`\nKubo containers will pick this up automatically at /home/dev/.katulong/credentials/`);
}

const subcommands = { api: apiSetup };

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
