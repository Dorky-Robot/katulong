/**
 * CLI: katulong apikey <subcommand>
 *
 * Manages API keys via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable } from "../format.js";

function usage() {
  console.log(`
Usage: katulong apikey <subcommand> [options]

Subcommands:
  create <name>   Create an API key (shown once)
  list            List API keys
  revoke <id>     Revoke an API key

Options:
  --json          Output as JSON
`);
}

async function create(args) {
  const jsonMode = args.includes("--json");
  const name = args.filter(a => a !== "--json").join(" ").trim();
  if (!name) {
    console.error("Usage: katulong apikey create <name>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.post("/api/api-keys", { name });

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`API key created:
  ID:     ${data.id}
  Name:   ${data.name}
  Key:    ${data.key}

Save this key — it will not be shown again.`);
  }
}

async function list(args) {
  const jsonMode = args.includes("--json");

  ensureRunning();
  const keys = await api.get("/api/api-keys");

  if (jsonMode) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }

  if (keys.length === 0) {
    console.log("No API keys.");
    return;
  }

  const rows = keys.map(k => [
    k.id,
    k.name,
    k.prefix + "...",
    k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never",
  ]);
  process.stdout.write(formatTable(["ID", "NAME", "PREFIX", "LAST USED"], rows));
}

async function revoke(args) {
  const jsonMode = args.includes("--json");
  const id = args.find(a => a !== "--json");
  if (!id) {
    console.error("Usage: katulong apikey revoke <id>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.del(`/api/api-keys/${encodeURIComponent(id)}`);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("API key revoked.");
  }
}

const subcommands = { create, list, revoke };

export default async function apikey(args) {
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
