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
    // Check if existing config actually works before protecting it
    const existing = JSON.parse(readFileSync(REMOTE_PATH, "utf-8"));
    try {
      const res = await fetch(`${existing.url}/sessions`, {
        headers: { "Authorization": `Bearer ${existing.apiKey}` },
      });
      if (res.ok) {
        console.log(`Self-access already configured and working.`);
        console.log(`  URL: ${existing.url}`);
        console.log(`\nUse --force to replace it.`);
        process.exit(0);
      }
    } catch { /* can't reach it — fall through to replace */ }
    console.log(`Existing remote.json is broken — replacing it.`);
  }

  ensureRunning();

  // Get the instance's public URL
  const { url } = await api.get("/api/external-url");
  if (!url) {
    console.error("No external URL configured for this instance.");
    console.error("Set up a Cloudflare tunnel or configure the external URL first.");
    process.exit(1);
  }

  // Create an API key via the local server
  const keyData = await api.post("/api/api-keys", { name: "self-access" });

  // Write discovery file
  mkdirSync(KATULONG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(REMOTE_PATH, JSON.stringify({ url, apiKey: keyData.key }, null, 2) + "\n", { mode: 0o600 });

  // Verify the key actually works against the public URL.
  // This catches data dir mismatches, caching issues, and tunnel problems.
  console.log(`Verifying access via ${url} ...`);
  let verified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${url}/sessions`, {
        headers: { "Authorization": `Bearer ${keyData.key}` },
      });
      if (res.ok) {
        verified = true;
        break;
      }
      // 302 = auth rejected, key not recognized. Wait and retry in case
      // the server needs time to flush its auth state cache.
      if (attempt < 2) {
        console.log(`  Key not recognized yet (HTTP ${res.status}), retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      if (attempt < 2) {
        console.log(`  Connection failed (${err.cause?.code || err.message}), retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (verified) {
    console.log(`\nSelf-access configured and verified.`);
    console.log(`  File: ${REMOTE_PATH}`);
    console.log(`  URL:  ${url}`);
    console.log(`\nKubo containers will pick this up at /home/dev/.katulong/remote.json`);
  } else {
    console.error(`\nWarning: remote.json was written but verification failed.`);
    console.error(`The API key was created but the public URL didn't accept it.`);
    console.error(`This usually means the server's auth cache is stale.`);
    console.error(`\nTry: katulong restart && katulong setup self-access --force`);
    process.exit(1);
  }
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
