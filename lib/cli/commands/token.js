/**
 * CLI: katulong token <subcommand>
 *
 * Manages setup tokens via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable, formatExpiry } from "../../ssh-commands.js";

function usage() {
  console.log(`
Usage: katulong token <subcommand> [options]

Subcommands:
  create <name>   Create a setup token (shown once)
  list            List setup tokens
  revoke <id>     Revoke a token (and linked credential)

Options:
  --json          Output as JSON
`);
}

async function create(args) {
  const jsonMode = args.includes("--json");
  const name = args.filter(a => a !== "--json").join(" ").trim();
  if (!name) {
    console.error("Usage: katulong token create <name>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.post("/api/tokens", { name });

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Token created:
  ID:      ${data.id}
  Name:    ${data.name}
  Token:   ${data.token}
  Expires: ${formatExpiry(data.expiresAt)}

Save this token — it will not be shown again.`);
  }
}

async function list(args) {
  const jsonMode = args.includes("--json");

  ensureRunning();
  const data = await api.get("/api/tokens");
  const tokens = data.tokens || [];

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (tokens.length === 0) {
    console.log("No tokens.");
    return;
  }

  const rows = tokens.map(t => [
    t.id,
    t.name,
    formatExpiry(t.expiresAt),
    t.credential ? t.credential.name : "-",
  ]);
  process.stdout.write(formatTable(["ID", "NAME", "EXPIRES", "CREDENTIAL"], rows));
}

async function revoke(args) {
  const jsonMode = args.includes("--json");
  const id = args.find(a => a !== "--json");
  if (!id) {
    console.error("Usage: katulong token revoke <id>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.del(`/api/tokens/${encodeURIComponent(id)}`);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("Token revoked.");
  }
}

const subcommands = { create, list, revoke };

export default async function token(args) {
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
