/**
 * CLI: katulong session <subcommand>
 *
 * Manages PTY sessions via the local server API.
 */

import { ensureRunning, api } from "../api-client.js";
import { formatTable } from "../format.js";

/**
 * Auto-generated session names use `session-${Date.now().toString(36)}` in the
 * frontend (public/app.js). This pattern matches that: "session-" followed by
 * one or more base-36 characters (lowercase letters and digits).
 */
const AUTO_NAME_RE = /^session-[0-9a-z]+$/;

function usage() {
  console.log(`
Usage: katulong session <subcommand> [options]

Subcommands:
  list                  List active PTY sessions
  create <name> [--open]  Create a new PTY session (--open broadcasts to browsers)
  kill <name>           Kill a PTY session
  rename <old> <new>    Rename a PTY session
  prune                 Kill orphaned auto-generated sessions (no child processes)

Options:
  --json                Output as JSON
  --dry-run             (prune) Show what would be pruned without killing
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
  const openFlag = args.includes("--open");
  const name = args.filter(a => a !== "--json" && a !== "--open").join(" ").trim();
  if (!name) {
    console.error("Usage: katulong session create <name> [--open]");
    process.exit(1);
  }

  ensureRunning();
  const data = await api.post("/sessions", { name });

  if (openFlag) {
    await api.post("/attach", { name: data.name });
  }

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Session "${data.name}" created.${openFlag ? " (opened in browser)" : ""}`);
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

async function prune(args) {
  const jsonMode = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  ensureRunning();
  const sessions = await api.get("/sessions");

  if (!Array.isArray(sessions)) {
    console.error("Unexpected response from server.");
    process.exit(1);
  }

  const orphans = sessions.filter(
    s => AUTO_NAME_RE.test(s.name) && s.alive && !s.hasChildProcesses
  );

  if (orphans.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ pruned: 0, sessions: [] }));
    } else {
      console.log("No orphaned sessions to prune.");
    }
    return;
  }

  if (dryRun) {
    if (jsonMode) {
      console.log(JSON.stringify({ wouldPrune: orphans.length, sessions: orphans.map(s => s.name) }));
    } else {
      console.log(`Would prune ${orphans.length} session(s):`);
      for (const s of orphans) {
        console.log(`  ${s.name}`);
      }
    }
    return;
  }

  const pruned = [];
  for (const s of orphans) {
    await api.del(`/sessions/${encodeURIComponent(s.name)}`);
    pruned.push(s.name);
  }

  if (jsonMode) {
    console.log(JSON.stringify({ pruned: pruned.length, sessions: pruned }));
  } else {
    console.log(`Pruned ${pruned.length} session(s).`);
  }
}

const subcommands = { list, create, kill, rename, prune };

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
