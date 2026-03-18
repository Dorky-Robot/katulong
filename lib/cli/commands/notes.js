/**
 * CLI: katulong notes <subcommand>
 *
 * Read and manage per-session notepad content via the local server API.
 * Each line is a block. Blocks are addressed by 0-based index.
 * Notes are markdown with checkbox support (- [ ] / - [x]).
 */

import { ensureRunning, api } from "../api-client.js";
import { execFileSync } from "node:child_process";

function usage() {
  console.log(`
Usage: katulong notes <subcommand> [options]

Reading:
  read [session]                  Print the full note (with line numbers)
  get <index> [session]           Print a single block by index
  todos [session]                 List unchecked todos (with indices)

Editing:
  add <text> [session]            Append a new line
  insert <index> <text> [session] Insert a line at index (shifts others down)
  edit <index> <text> [session]   Replace a block's content
  rm <index> [session]            Remove a block
  move <from> <to> [session]      Move a block from one index to another
  clear [session]                 Remove all blocks

Checkboxes:
  check <index|text> [session]    Check off a todo (by index or text match)
  uncheck <index|text> [session]  Uncheck a todo (by index or text match)

Meta:
  list                            List sessions that have notes

Options:
  --session <name>                Explicit session (default: auto-detect from tmux)
  --json                          Output as JSON
  --raw                           Omit line numbers from read output

Examples:
  katulong notes read
  katulong notes todos
  katulong notes add "write tests"
  katulong notes check 2
  katulong notes check "fix the bug"
  katulong notes move 0 3
  katulong notes insert 0 "# Sprint goals"
  katulong notes edit 2 "- [ ] updated task"
  katulong notes rm 4
`);
}

// --- Helpers ---

function detectSession() {
  try {
    const name = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
      timeout: 2000, encoding: "utf-8",
    }).trim();
    if (name) return name;
  } catch { /* not in tmux */ }
  return null;
}

function parseArgs(args) {
  const flags = { json: false, session: null, raw: false };
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") flags.json = true;
    else if (args[i] === "--raw") flags.raw = true;
    else if (args[i] === "--session" && i + 1 < args.length) flags.session = args[++i];
    else positionals.push(args[i]);
  }
  return { flags, positionals };
}

function resolveSession(flags, positionals, textCommand = false) {
  if (flags.session) return { session: flags.session, rest: positionals };
  if (textCommand) return { session: detectSession(), rest: positionals };
  return { session: positionals[0] || detectSession(), rest: positionals.slice(1) };
}

function requireSession(session) {
  if (!session) {
    console.error("Could not detect session. Use --session <name> or run inside tmux.");
    process.exit(1);
  }
}

function parseIndex(s, lineCount) {
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n >= lineCount) {
    console.error(`Invalid index: ${s} (valid range: 0–${lineCount - 1})`);
    process.exit(1);
  }
  return n;
}

async function getLines(session) {
  const data = await api.get(`/api/notes/${encodeURIComponent(session)}`);
  const content = data.content || "";
  return content ? content.split("\n") : [];
}

async function saveLines(session, lines) {
  await api.put(`/api/notes/${encodeURIComponent(session)}`, { content: lines.join("\n") });
}

// --- Subcommands ---

async function read(args) {
  const { flags, positionals } = parseArgs(args);
  const { session } = resolveSession(flags, positionals);
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);

  if (flags.json) {
    console.log(JSON.stringify({ session, blocks: lines.map((text, i) => ({ index: i, text })) }, null, 2));
    return;
  }

  if (lines.length === 0) {
    console.error(`No notes for session "${session}".`);
    process.exit(0);
  }

  for (let i = 0; i < lines.length; i++) {
    console.log(flags.raw ? lines[i] : `${String(i).padStart(3)}  ${lines[i]}`);
  }
}

async function get(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 1) { console.error("Usage: katulong notes get <index>"); process.exit(1); }
  const idxStr = positionals[0];
  const { session } = resolveSession(flags, positionals.slice(1));
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const idx = parseIndex(idxStr, lines.length);

  if (flags.json) {
    console.log(JSON.stringify({ session, index: idx, text: lines[idx] }, null, 2));
  } else {
    console.log(lines[idx]);
  }
}

async function todos(args) {
  const { flags, positionals } = parseArgs(args);
  const { session } = resolveSession(flags, positionals);
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const unchecked = lines
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => /^- \[ \] /.test(text));

  if (flags.json) {
    console.log(JSON.stringify({
      session,
      todos: unchecked.map(({ text, index }) => ({ index, text: text.replace(/^- \[ \] /, "") })),
    }, null, 2));
    return;
  }

  if (unchecked.length === 0) {
    console.log("No unchecked todos.");
    return;
  }

  for (const { text, index } of unchecked) {
    console.log(`${String(index).padStart(3)}  ${text}`);
  }
}

async function add(args) {
  const { flags, positionals } = parseArgs(args);
  const { session, rest } = resolveSession(flags, positionals, true);
  const text = rest.join(" ");
  if (!text) { console.error("Usage: katulong notes add <text>"); process.exit(1); }
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  lines.push(text);
  await saveLines(session, lines);
  console.log(`${lines.length - 1}  ${text}`);
}

async function insert(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes insert <index> <text>"); process.exit(1); }
  const idxStr = positionals[0];
  const { session } = resolveSession(flags, positionals.slice(1), true);
  // Text is everything after the index
  const text = positionals.slice(1).join(" ");
  if (flags.session) {
    // --session was used, so all positionals after index are text
  }
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  // Allow inserting at end (index === length)
  const idx = parseInt(idxStr, 10);
  if (isNaN(idx) || idx < 0 || idx > lines.length) {
    console.error(`Invalid index: ${idxStr} (valid range: 0–${lines.length})`);
    process.exit(1);
  }

  lines.splice(idx, 0, text);
  await saveLines(session, lines);
  console.log(`${String(idx).padStart(3)}  ${text}`);
}

async function edit(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes edit <index> <text>"); process.exit(1); }
  const idxStr = positionals[0];
  const { session } = resolveSession(flags, positionals.slice(1), true);
  const text = positionals.slice(1).join(" ");
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const idx = parseIndex(idxStr, lines.length);

  const old = lines[idx];
  lines[idx] = text;
  await saveLines(session, lines);
  console.log(`${String(idx).padStart(3)}  ${old}  →  ${text}`);
}

async function rm(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 1) { console.error("Usage: katulong notes rm <index>"); process.exit(1); }
  const idxStr = positionals[0];
  const { session } = resolveSession(flags, positionals.slice(1));
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const idx = parseIndex(idxStr, lines.length);

  const [removed] = lines.splice(idx, 1);
  await saveLines(session, lines);
  console.log(`Removed: ${removed}`);
}

async function move(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes move <from> <to>"); process.exit(1); }
  const { session } = resolveSession(flags, positionals.slice(2));
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const from = parseIndex(positionals[0], lines.length);
  const to = parseIndex(positionals[1], lines.length);

  const [item] = lines.splice(from, 1);
  lines.splice(to, 0, item);
  await saveLines(session, lines);
  console.log(`Moved "${item}" from ${from} → ${to}`);
}

async function clear(args) {
  const { flags, positionals } = parseArgs(args);
  const { session } = resolveSession(flags, positionals);
  requireSession(session);
  ensureRunning();

  await saveLines(session, []);
  console.log(`Cleared notes for "${session}".`);
}

async function check(args) {
  const { flags, positionals } = parseArgs(args);
  const { session, rest } = resolveSession(flags, positionals, true);
  const target = rest.join(" ");
  if (!target) { console.error("Usage: katulong notes check <index|text>"); process.exit(1); }
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const asNum = parseInt(target, 10);
  let idx = -1;

  if (!isNaN(asNum) && String(asNum) === target.trim() && asNum >= 0 && asNum < lines.length) {
    // Treat as index
    if (/^- \[ \] /.test(lines[asNum])) idx = asNum;
    else { console.error(`Block ${asNum} is not an unchecked todo.`); process.exit(1); }
  } else {
    // Text match
    const needle = target.toLowerCase();
    idx = lines.findIndex(l => /^- \[ \] /.test(l) && l.toLowerCase().includes(needle));
    if (idx === -1) { console.error(`No unchecked todo matching "${target}".`); process.exit(1); }
  }

  lines[idx] = lines[idx].replace("- [ ] ", "- [x] ");
  await saveLines(session, lines);
  console.log(`${String(idx).padStart(3)}  ${lines[idx]}`);
}

async function uncheck(args) {
  const { flags, positionals } = parseArgs(args);
  const { session, rest } = resolveSession(flags, positionals, true);
  const target = rest.join(" ");
  if (!target) { console.error("Usage: katulong notes uncheck <index|text>"); process.exit(1); }
  requireSession(session);
  ensureRunning();

  const lines = await getLines(session);
  const asNum = parseInt(target, 10);
  let idx = -1;

  if (!isNaN(asNum) && String(asNum) === target.trim() && asNum >= 0 && asNum < lines.length) {
    if (/^- \[x\] /i.test(lines[asNum])) idx = asNum;
    else { console.error(`Block ${asNum} is not a checked todo.`); process.exit(1); }
  } else {
    const needle = target.toLowerCase();
    idx = lines.findIndex(l => /^- \[x\] /i.test(l) && l.toLowerCase().includes(needle));
    if (idx === -1) { console.error(`No checked todo matching "${target}".`); process.exit(1); }
  }

  lines[idx] = lines[idx].replace(/^- \[x\] /i, "- [ ] ");
  await saveLines(session, lines);
  console.log(`${String(idx).padStart(3)}  ${lines[idx]}`);
}

async function list(args) {
  const { flags } = parseArgs(args);
  ensureRunning();
  const sessions = await api.get("/sessions");

  const noteSessions = [];
  for (const s of sessions) {
    try {
      const lines = await getLines(s.name);
      if (lines.length > 0 && lines.some(l => l.trim())) {
        const todoCount = lines.filter(l => /^- \[ \] /.test(l)).length;
        const doneCount = lines.filter(l => /^- \[x\] /i.test(l)).length;
        noteSessions.push({ name: s.name, blocks: lines.length, todos: todoCount, done: doneCount });
      }
    } catch { /* skip */ }
  }

  if (flags.json) {
    console.log(JSON.stringify(noteSessions, null, 2));
    return;
  }

  if (noteSessions.length === 0) {
    console.log("No sessions have notes.");
    return;
  }

  for (const s of noteSessions) {
    const counts = s.todos + s.done > 0 ? ` — ${s.todos} todo, ${s.done} done` : "";
    console.log(`  ${s.name} (${s.blocks} blocks${counts})`);
  }
}

const subcommands = { read, get, todos, add, insert, edit, rm, move, clear, check, uncheck, list };

export default async function notes(args) {
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
