/**
 * CLI: katulong notes <subcommand>
 *
 * Read and manage notes via the local server API. Notes are flat-name
 * markdown files in DATA_DIR/notes/<name>.md — there is no session
 * coupling; each note is identified by its name only. Each line of the
 * markdown body is a "block" addressable by 0-based index, matching the
 * tile editor's per-line block model so CLI edits round-trip cleanly
 * with what the user sees in the browser.
 */

import { ensureRunning, api } from "../api-client.js";

function usage() {
  console.log(`
Usage: katulong notes <subcommand> [options]

Reading:
  list                            List all notes
  read --name <note>              Print the full note (with line numbers)
  get <index> --name <note>       Print a single block by index
  todos --name <note>             List unchecked todos (with indices)

Editing:
  new [--name <note>]             Create a new note (server picks untitled-N if no name)
  add <text> --name <note>        Append a new line
  insert <index> <text> --name <note>  Insert a line at index
  edit <index> <text> --name <note>    Replace a block's content
  rm <index> --name <note>        Remove a block
  move <from> <to> --name <note>  Move a block from one index to another
  clear --name <note>             Remove all blocks
  rename <newName> --name <note>  Rename a note (file moves on disk)
  delete --name <note>            Delete a note entirely

Checkboxes:
  check <index|text> --name <note>     Check off a todo
  uncheck <index|text> --name <note>   Uncheck a todo

Options:
  --name <note>                   Note name (required for per-note ops)
  --json                          Output as JSON
  --raw                           Omit line numbers from read output

Examples:
  katulong notes list
  katulong notes read --name sprint-plan
  katulong notes add "write tests" --name sprint-plan
  katulong notes check 2 --name sprint-plan
  katulong notes rename "sprint plan v2" --name sprint-plan
`);
}

// --- Helpers ---

function parseArgs(args) {
  const flags = { json: false, name: null, raw: false };
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") flags.json = true;
    else if (args[i] === "--raw") flags.raw = true;
    else if (args[i] === "--name" && i + 1 < args.length) flags.name = args[++i];
    else positionals.push(args[i]);
  }
  return { flags, positionals };
}

function requireName(name) {
  if (!name) {
    console.error('Missing --name <note>. Use "katulong notes list" to see available notes.');
    process.exit(1);
  }
}

function parseIndex(s, lineCount) {
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n >= lineCount) {
    console.error(`Invalid index: ${s} (valid range: 0-${lineCount - 1})`);
    process.exit(1);
  }
  return n;
}

async function getLines(name) {
  const data = await api.get(`/api/notes/${encodeURIComponent(name)}`);
  const content = data && typeof data.content === "string" ? data.content : "";
  return content ? content.split("\n") : [];
}

async function saveLines(name, lines) {
  await api.put(`/api/notes/${encodeURIComponent(name)}`, { content: lines.join("\n") });
}

// --- Subcommands ---

async function read(args) {
  const { flags } = parseArgs(args);
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);

  if (flags.json) {
    console.log(JSON.stringify({ name: flags.name, blocks: lines.map((text, i) => ({ index: i, text })) }, null, 2));
    return;
  }

  if (lines.length === 0) {
    console.error(`Note "${flags.name}" is empty.`);
    process.exit(0);
  }

  for (let i = 0; i < lines.length; i++) {
    console.log(flags.raw ? lines[i] : `${String(i).padStart(3)}  ${lines[i]}`);
  }
}

async function get(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 1) { console.error("Usage: katulong notes get <index> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const idx = parseIndex(positionals[0], lines.length);

  if (flags.json) {
    console.log(JSON.stringify({ name: flags.name, index: idx, text: lines[idx] }, null, 2));
  } else {
    console.log(lines[idx]);
  }
}

async function todos(args) {
  const { flags } = parseArgs(args);
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const unchecked = lines
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => /^- \[ \] /.test(text));

  if (flags.json) {
    console.log(JSON.stringify({
      name: flags.name,
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

async function newNote(args) {
  const { flags } = parseArgs(args);
  ensureRunning();

  const body = {};
  if (flags.name) body.name = flags.name;
  const result = await api.post("/api/notes", body);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Created: ${result.name}`);
  }
}

async function add(args) {
  const { flags, positionals } = parseArgs(args);
  const text = positionals.join(" ");
  if (!text) { console.error("Usage: katulong notes add <text> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  lines.push(text);
  await saveLines(flags.name, lines);
  console.log(`${lines.length - 1}  ${text}`);
}

async function insert(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes insert <index> <text> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const idxStr = positionals[0];
  const idx = parseInt(idxStr, 10);
  if (isNaN(idx) || idx < 0 || idx > lines.length) {
    console.error(`Invalid index: ${idxStr} (valid range: 0-${lines.length})`);
    process.exit(1);
  }
  const text = positionals.slice(1).join(" ");
  lines.splice(idx, 0, text);
  await saveLines(flags.name, lines);
  console.log(`${String(idx).padStart(3)}  ${text}`);
}

async function edit(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes edit <index> <text> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const idx = parseIndex(positionals[0], lines.length);
  const text = positionals.slice(1).join(" ");
  const old = lines[idx];
  lines[idx] = text;
  await saveLines(flags.name, lines);
  console.log(`${String(idx).padStart(3)}  ${old}  ->  ${text}`);
}

async function rm(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 1) { console.error("Usage: katulong notes rm <index> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const idx = parseIndex(positionals[0], lines.length);
  const [removed] = lines.splice(idx, 1);
  await saveLines(flags.name, lines);
  console.log(`Removed: ${removed}`);
}

async function move(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 2) { console.error("Usage: katulong notes move <from> <to> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const from = parseIndex(positionals[0], lines.length);
  const to = parseIndex(positionals[1], lines.length);
  const [item] = lines.splice(from, 1);
  lines.splice(to, 0, item);
  await saveLines(flags.name, lines);
  console.log(`Moved "${item}" from ${from} -> ${to}`);
}

async function clear(args) {
  const { flags } = parseArgs(args);
  requireName(flags.name);
  ensureRunning();

  await saveLines(flags.name, []);
  console.log(`Cleared notes for "${flags.name}".`);
}

async function rename(args) {
  const { flags, positionals } = parseArgs(args);
  if (positionals.length < 1) { console.error("Usage: katulong notes rename <newName> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const newName = positionals.join(" ");
  const result = await api.patch(`/api/notes/${encodeURIComponent(flags.name)}`, { newName });
  console.log(`Renamed: ${flags.name} -> ${result.name || newName}`);
}

async function deleteNote(args) {
  const { flags } = parseArgs(args);
  requireName(flags.name);
  ensureRunning();

  await api.delete(`/api/notes/${encodeURIComponent(flags.name)}`);
  console.log(`Deleted: ${flags.name}`);
}

async function check(args) {
  const { flags, positionals } = parseArgs(args);
  const target = positionals.join(" ");
  if (!target) { console.error("Usage: katulong notes check <index|text> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const asNum = parseInt(target, 10);
  let idx = -1;

  if (!isNaN(asNum) && String(asNum) === target.trim() && asNum >= 0 && asNum < lines.length) {
    if (/^- \[ \] /.test(lines[asNum])) idx = asNum;
    else { console.error(`Block ${asNum} is not an unchecked todo.`); process.exit(1); }
  } else {
    const needle = target.toLowerCase();
    idx = lines.findIndex((l) => /^- \[ \] /.test(l) && l.toLowerCase().includes(needle));
    if (idx === -1) { console.error(`No unchecked todo matching "${target}".`); process.exit(1); }
  }

  lines[idx] = lines[idx].replace("- [ ] ", "- [x] ");
  await saveLines(flags.name, lines);
  console.log(`${String(idx).padStart(3)}  ${lines[idx]}`);
}

async function uncheck(args) {
  const { flags, positionals } = parseArgs(args);
  const target = positionals.join(" ");
  if (!target) { console.error("Usage: katulong notes uncheck <index|text> --name <note>"); process.exit(1); }
  requireName(flags.name);
  ensureRunning();

  const lines = await getLines(flags.name);
  const asNum = parseInt(target, 10);
  let idx = -1;

  if (!isNaN(asNum) && String(asNum) === target.trim() && asNum >= 0 && asNum < lines.length) {
    if (/^- \[x\] /i.test(lines[asNum])) idx = asNum;
    else { console.error(`Block ${asNum} is not a checked todo.`); process.exit(1); }
  } else {
    const needle = target.toLowerCase();
    idx = lines.findIndex((l) => /^- \[x\] /i.test(l) && l.toLowerCase().includes(needle));
    if (idx === -1) { console.error(`No checked todo matching "${target}".`); process.exit(1); }
  }

  lines[idx] = lines[idx].replace(/^- \[x\] /i, "- [ ] ");
  await saveLines(flags.name, lines);
  console.log(`${String(idx).padStart(3)}  ${lines[idx]}`);
}

async function list(args) {
  const { flags } = parseArgs(args);
  ensureRunning();
  const data = await api.get("/api/notes");
  const notes = (data && Array.isArray(data.notes)) ? data.notes : [];

  if (flags.json) {
    console.log(JSON.stringify(notes, null, 2));
    return;
  }

  if (notes.length === 0) {
    console.log("No notes yet. Create one with: katulong notes new");
    return;
  }

  for (const n of notes) {
    const when = n.mtime ? new Date(n.mtime).toISOString() : "";
    console.log(`  ${n.name}  (${n.size}B  ${when})`);
  }
}

const subcommands = {
  list, read, get, todos,
  new: newNote, add, insert, edit, rm, move, clear,
  rename, delete: deleteNote, check, uncheck,
};

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
