/**
 * CLI: katulong session <subcommand>
 *
 * Manages PTY sessions via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable } from "../../ssh-commands.js";

function usage() {
  console.log(`
Usage: katulong session <subcommand> [options]

Subcommands:
  list                  List active PTY sessions
  create <name>         Create a new PTY session
  kill <name>           Kill a PTY session
  rename <old> <new>    Rename a PTY session

Options:
  --json                Output as JSON
`);
}

async function list(args) {
  const jsonMode = args.includes("--json");

  ensureRunning();
  const sessions = await api.get("/sessions");

  if (jsonMode) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (!Array.isArray(sessions) || sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  const rows = sessions.map(s => [
    s.name,
    String(s.clients || 0),
    s.alive ? "yes" : "no",
  ]);
  process.stdout.write(formatTable(["NAME", "CLIENTS", "ALIVE"], rows));
}

async function create(args) {
  const jsonMode = args.includes("--json");
  const name = args.filter(a => a !== "--json").join(" ").trim();
  if (!name) {
    console.error("Usage: katulong session create <name>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.post("/sessions", { name });

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Session "${data.name}" created.`);
  }
}

async function kill(args) {
  const jsonMode = args.includes("--json");
  const name = args.find(a => a !== "--json");
  if (!name) {
    console.error("Usage: katulong session kill <name>");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.del(`/sessions/${encodeURIComponent(name)}`);

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Session "${name}" killed.`);
  }
}

async function rename(args) {
  const jsonMode = args.includes("--json");
  const filtered = args.filter(a => a !== "--json");
  if (filtered.length < 2) {
    console.error("Usage: katulong session rename <old> <new>");
    process.exit(1);
  }
  const [oldName, newName] = filtered;

  ensureRunning();
  const data = await api.put(`/sessions/${encodeURIComponent(oldName)}`, { name: newName });

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Session renamed to "${data.name}".`);
  }
}

const subcommands = { list, create, kill, rename };

export default async function session(args) {
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
