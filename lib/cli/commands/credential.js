/**
 * CLI: katulong credential <subcommand>
 *
 * Manages passkey credentials via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable, formatRelativeTime } from "../../ssh-commands.js";

function usage() {
  console.log(`
Usage: katulong credential <subcommand> [options]

Subcommands:
  list            List registered passkeys
  revoke <id>     Revoke a passkey

Options:
  --json          Output as JSON
`);
}

async function list(args) {
  const jsonMode = args.includes("--json");

  ensureRunning();
  const data = await api.get("/api/credentials");
  const credentials = data.credentials || [];

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (credentials.length === 0) {
    console.log("No credentials.");
    return;
  }

  const rows = credentials.map(c => [
    c.id,
    c.name || "Unknown",
    formatRelativeTime(c.createdAt),
    formatRelativeTime(c.lastUsedAt),
  ]);
  process.stdout.write(formatTable(["ID", "NAME", "CREATED", "LAST USED"], rows));
}

async function revoke(args) {
  const jsonMode = args.includes("--json");
  const id = args.find(a => a !== "--json");
  if (!id) {
    console.error("Usage: katulong credential revoke <id>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.del(`/api/credentials/${encodeURIComponent(id)}`);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("Credential revoked.");
  }
}

const subcommands = { list, revoke };

export default async function credential(args) {
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
