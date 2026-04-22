/**
 * CLI: katulong apikey <subcommand>
 *
 * Manages API keys via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable } from "../format.js";
import qrcode from "qrcode-terminal";

function usage() {
  console.log(`
Usage: katulong apikey <subcommand> [options]

Subcommands:
  create <name>   Create an API key (shown once)
  list            List API keys
  revoke <id>     Revoke an API key

Options:
  --json              Output as JSON
  --scope <name>      Restrict key to a scope (repeatable). Known scopes:
                      full (default), mint-session
`);
}

function parseScopeArgs(args) {
  const scopes = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--scope") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        console.error("--scope requires a value");
        process.exit(1);
      }
      scopes.push(next);
      i++;
    } else if (a.startsWith("--scope=")) {
      scopes.push(a.slice("--scope=".length));
    } else {
      rest.push(a);
    }
  }
  return { scopes, rest };
}

async function create(args) {
  const { scopes, rest } = parseScopeArgs(args);
  const jsonMode = rest.includes("--json");
  const name = rest.filter(a => a !== "--json").join(" ").trim();
  if (!name) {
    console.error("Usage: katulong apikey create <name> [--scope <name>]...");
    process.exit(1);
  }

  ensureRunning();
  const payload = scopes.length ? { name, scopes } : { name };
  const data = await api.post("/api/api-keys", payload);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const scopeList = Array.isArray(data.scopes) ? data.scopes.join(", ") : "full";
    console.log(`\nAPI key created:
  ID:     ${data.id}
  Name:   ${data.name}
  Scopes: ${scopeList}
  Key:    ${data.key}\n`);

    qrcode.generate(data.key, { small: true }, (code) => {
      console.log(code);
      console.log(`Save this key — it will not be shown again.\n`);
      const isFullOnly = Array.isArray(data.scopes) && data.scopes.length === 1 && data.scopes[0] === "full";
      if (isFullOnly) {
        console.log("Note: this key has full access to the API. For fleet federation use --scope mint-session.\n");
      }
    });
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
    Array.isArray(k.scopes) && k.scopes.length ? k.scopes.join(",") : "full",
    k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never",
  ]);
  process.stdout.write(formatTable(["ID", "NAME", "PREFIX", "SCOPES", "LAST USED"], rows));
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
