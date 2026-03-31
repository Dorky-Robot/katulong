/**
 * CLI: katulong crew <subcommand>
 *
 * Project-namespaced session orchestrator. Sessions use the naming
 * convention {project}--{worker} so multiple workers can be grouped,
 * monitored, and torn down per project.
 */

import { ensureRunning, api, BASE } from "../api-client.js";
import { formatTable } from "../format.js";

// --- Naming helpers ---

const SEPARATOR = "--";

function crewSessionName(project, worker) {
  return `${project}${SEPARATOR}${worker}`;
}

function parseCrewSession(name) {
  const idx = name.indexOf(SEPARATOR);
  if (idx === -1) return null;
  return { project: name.slice(0, idx), worker: name.slice(idx + SEPARATOR.length) };
}

function isCrewSession(name) {
  return name.includes(SEPARATOR);
}

function extractFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val || null;
}

// --- Usage ---

function usage() {
  console.log(`
Usage: katulong crew <subcommand> [options]

Subcommands:
  list                                    List all projects
  status [project]                        Show workers grouped by project
  spawn <project> <worker> [--cmd "..."]  Create a worker session
  exec <project> <worker> <command...>    Send a command to a worker
  output <project> <worker> [--lines N]   Read worker output
  wait <project> <worker>                 Wait until worker finishes running
  kill <project> [worker]                 Kill a worker or entire project

Options:
  --json         Output as JSON
  --follow, -f   Follow output in real time (with output)
  --lines N      Number of lines to show (default: 20)
  --cmd "..."    Command to run after spawning

Examples:
  katulong crew spawn myapp frontend --cmd "claude 'fix login bug'"
  katulong crew spawn myapp backend
  katulong crew exec myapp backend "npm test"
  katulong crew output myapp frontend --follow
  katulong crew wait myapp frontend       # blocks until idle
  katulong crew status myapp
  katulong crew kill myapp frontend
  katulong crew kill myapp              # kills all workers in project
`);
}

// --- Subcommands ---

async function list(args) {
  ensureRunning();
  const jsonMode = args.includes("--json");
  const sessions = await api.get("/sessions");

  const projects = new Map();
  for (const s of sessions) {
    const parsed = parseCrewSession(s.name);
    if (!parsed) continue;
    if (!projects.has(parsed.project)) projects.set(parsed.project, { workers: 0, alive: 0 });
    const p = projects.get(parsed.project);
    p.workers++;
    if (s.alive) p.alive++;
  }

  if (jsonMode) {
    const result = [...projects.entries()].map(([name, p]) => ({ project: name, ...p }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (projects.size === 0) {
    console.log("No crew projects. Create one with: katulong crew spawn <project> <worker>");
    return;
  }

  const rows = [...projects.entries()].map(([name, p]) => [name, String(p.workers), String(p.alive)]);
  process.stdout.write(formatTable(["PROJECT", "WORKERS", "ALIVE"], rows));
}

async function status(args) {
  ensureRunning();
  const jsonMode = args.includes("--json");
  const targetProject = args.find(a => !a.startsWith("--"));
  const sessions = await api.get("/sessions");

  const grouped = new Map();
  for (const s of sessions) {
    const parsed = parseCrewSession(s.name);
    if (!parsed) continue;
    if (targetProject && parsed.project !== targetProject) continue;
    if (!grouped.has(parsed.project)) grouped.set(parsed.project, []);
    grouped.get(parsed.project).push({
      worker: parsed.worker,
      alive: s.alive,
      busy: s.hasChildProcesses,
    });
  }

  if (jsonMode) {
    const result = Object.fromEntries(grouped);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (grouped.size === 0) {
    console.log(targetProject ? `No workers found for project "${targetProject}".` : "No crew projects.");
    return;
  }

  for (const [project, workers] of grouped) {
    console.log(`\n  ${project}`);
    const rows = workers.map(w => [
      w.worker,
      w.alive ? "alive" : "dead",
      w.busy ? "busy" : "idle",
    ]);
    process.stdout.write(formatTable(["  WORKER", "STATUS", "ACTIVITY"], rows));
  }
}

async function spawn(args) {
  ensureRunning();
  const cmd = extractFlag(args, "--cmd");
  const filtered = args.filter(a => !a.startsWith("--"));
  const [project, worker] = filtered;

  if (!project || !worker) {
    console.error("Usage: katulong crew spawn <project> <worker> [--cmd \"...\"]");
    process.exit(1);
  }

  const sessionName = crewSessionName(project, worker);
  if (sessionName.length > 64) {
    console.error(`Error: session name too long (${sessionName.length}/64). Use shorter project/worker names.`);
    process.exit(1);
  }

  await api.post("/sessions", { name: sessionName });
  console.log(`Spawned ${project}/${worker}`);

  if (cmd) {
    await api.post(`/sessions/${encodeURIComponent(sessionName)}/exec`, { input: cmd });
    console.log(`  cmd: ${cmd}`);
  }
}

async function exec(args) {
  ensureRunning();
  const filtered = args.filter(a => !a.startsWith("--"));
  const [project, worker, ...cmdParts] = filtered;

  if (!project || !worker || cmdParts.length === 0) {
    console.error("Usage: katulong crew exec <project> <worker> <command...>");
    process.exit(1);
  }

  const command = cmdParts.join(" ");
  const sessionName = crewSessionName(project, worker);
  await api.post(`/sessions/${encodeURIComponent(sessionName)}/exec`, { input: command });
  console.log(`Sent to ${project}/${worker}: ${command}`);
}

async function output(args) {
  ensureRunning();
  const follow = args.includes("--follow") || args.includes("-f");
  const linesFlag = extractFlag(args, "--lines");
  const lines = linesFlag ? parseInt(linesFlag, 10) : 20;
  const filtered = args.filter(a => !a.startsWith("--") && a !== "-f");
  const [project, worker] = filtered;

  if (!project || !worker) {
    console.error("Usage: katulong crew output <project> <worker> [--lines N] [--follow]");
    process.exit(1);
  }

  const sessionName = crewSessionName(project, worker);

  // Initial fetch
  const result = await api.get(`/sessions/${encodeURIComponent(sessionName)}/output?lines=${lines}`);
  process.stdout.write((result.data || result.screen || "") + "\n");

  if (!follow) return;

  // Follow mode: subscribe to SSE stream via topic broker
  process.on("SIGINT", () => process.exit(0));

  const topic = `sessions/${sessionName}/output`;
  try {
    const response = await fetch(`${BASE}/sub/${topic}`);
    if (!response.ok) {
      console.error(`Error subscribing to output stream: ${response.status}`);
      process.exit(1);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const envelope = JSON.parse(line.slice(6));
          if (envelope.event === "exit") {
            console.error("\nSession ended.");
            reader.cancel();
            return;
          }
          if (envelope.message) {
            process.stdout.write(envelope.message);
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") {
      console.error("Server is not running. Start with: katulong start");
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

async function wait(args) {
  ensureRunning();
  const jsonMode = args.includes("--json");
  const filtered = args.filter(a => !a.startsWith("--"));
  const [project, worker] = filtered;

  if (!project || !worker) {
    console.error("Usage: katulong crew wait <project> <worker>");
    process.exit(1);
  }

  const sessionName = crewSessionName(project, worker);
  const encodedName = encodeURIComponent(sessionName);

  // Poll every 2 seconds until hasChildProcesses becomes false
  while (true) {
    let status;
    try {
      status = await api.get(`/sessions/${encodedName}/status`);
    } catch (err) {
      if (err.message.includes("404") || err.message.includes("Not found")) {
        console.error(`Session ${project}/${worker} not found.`);
        process.exit(1);
      }
      throw err;
    }

    if (!status.alive) {
      if (!jsonMode) console.log(`${project}/${worker} is dead.`);
      if (jsonMode) console.log(JSON.stringify(status, null, 2));
      break;
    }

    if (!status.hasChildProcesses) {
      if (!jsonMode) console.log(`${project}/${worker} is idle.`);
      if (jsonMode) console.log(JSON.stringify(status, null, 2));
      break;
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

async function kill(args) {
  ensureRunning();
  const filtered = args.filter(a => !a.startsWith("--"));
  const [project, worker] = filtered;

  if (!project) {
    console.error("Usage: katulong crew kill <project> [worker]");
    process.exit(1);
  }

  if (worker) {
    const sessionName = crewSessionName(project, worker);
    await api.del(`/sessions/${encodeURIComponent(sessionName)}`);
    console.log(`Killed ${project}/${worker}`);
  } else {
    const sessions = await api.get("/sessions");
    const toKill = sessions.filter(s => {
      const parsed = parseCrewSession(s.name);
      return parsed && parsed.project === project;
    });

    if (toKill.length === 0) {
      console.log(`No workers found for project "${project}".`);
      return;
    }

    for (const s of toKill) {
      await api.del(`/sessions/${encodeURIComponent(s.name)}`);
    }
    console.log(`Killed ${toKill.length} worker(s) in project "${project}".`);
  }
}

// --- Dispatch ---

const subcommands = { list, status, spawn, exec, output, wait, kill };

export default async function crew(args) {
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

// Export helpers for testing
export { crewSessionName, parseCrewSession, isCrewSession };
