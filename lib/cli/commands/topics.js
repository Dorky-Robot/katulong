/**
 * CLI: katulong topics
 *
 * Subcommands:
 *   list              List active pub/sub topics (default)
 *   purge [--yes]     Identify and optionally delete noise topics
 *                     left over from retired releases.
 */

import { ensureRunning, api } from "../api-client.js";

const VALUABLE_STATUSES = new Set([
  "narrative", "completion", "attention", "summary",
]);

export default async function topics(args) {
  const hasSubcommand = args[0] && !args[0].startsWith("--");
  const sub = hasSubcommand ? args[0] : "list";
  const rest = hasSubcommand ? args.slice(1) : args;

  if (sub === "list") return list(rest);
  if (sub === "purge") return purge(rest);

  console.error(`Unknown subcommand: ${sub}`);
  console.error("Usage: katulong topics [list|purge] [options]");
  process.exit(1);
}

async function list(args) {
  const jsonMode = args.includes("--json");
  ensureRunning();

  try {
    const result = await api.get("/api/topics");
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.length) {
      console.log("No active topics.");
      return;
    }
    for (const t of result) {
      const subs = `${t.subscribers} sub${t.subscribers !== 1 ? "s" : ""}`;
      const seq = t.seq !== undefined ? `  seq:${t.seq}` : "";
      console.log(`  ${t.name.padEnd(30)} ${subs.padEnd(10)}${seq}`);
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}

async function purge(args) {
  const confirm = args.includes("--yes");
  ensureRunning();

  let topics;
  try {
    // ?all=1 so retired `sessions/*/output` topics come through —
    // `/api/topics` hides them from the feed-tile picker by default.
    topics = await api.get("/api/topics?all=1");
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  const drop = [];
  const keep = [];

  for (const t of topics) {
    const name = t.name;
    if (name.endsWith("/output")) {
      drop.push({ name, reason: "retired /output topic" });
      continue;
    }
    if (!name.startsWith("claude/")) {
      keep.push({ name, reason: "not a claude topic" });
      continue;
    }
    // Claude topic — inspect status counts
    let stats;
    try {
      stats = await api.get(`/api/topics/${encodeTopic(name)}/stats`);
    } catch (err) {
      keep.push({ name, reason: `stats error: ${err.message}` });
      continue;
    }
    const hasValue = Object.keys(stats.byStatus || {})
      .some(s => VALUABLE_STATUSES.has(s));
    if (!hasValue) {
      const summary = summarizeStatuses(stats.byStatus);
      drop.push({ name, reason: `no narrative/completion/attention (${summary})` });
    } else {
      const summary = summarizeStatuses(stats.byStatus);
      keep.push({ name, reason: summary });
    }
  }

  console.log(`\n${drop.length} topic${drop.length !== 1 ? "s" : ""} to delete:\n`);
  for (const { name, reason } of drop) {
    console.log(`  - ${name.padEnd(50)} ${reason}`);
  }
  console.log(`\n${keep.length} topic${keep.length !== 1 ? "s" : ""} to keep:\n`);
  for (const { name, reason } of keep) {
    console.log(`  = ${name.padEnd(50)} ${reason}`);
  }

  if (!confirm) {
    console.log("\nDry run — re-run with --yes to delete.");
    return;
  }

  if (drop.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  console.log("");
  let deleted = 0;
  let failed = 0;
  for (const { name } of drop) {
    try {
      await api.del(`/api/topics/${encodeTopic(name)}`);
      deleted++;
      console.log(`  ✓ deleted ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name} — ${err.message}`);
    }
  }
  console.log(`\nDeleted ${deleted}, failed ${failed}.`);
}

function encodeTopic(name) {
  // Topic names may contain "/"; encode each segment so the path
  // reaches the prefix router intact.
  return name.split("/").map(encodeURIComponent).join("/");
}

function summarizeStatuses(byStatus) {
  if (!byStatus || Object.keys(byStatus).length === 0) return "empty log";
  return Object.entries(byStatus)
    .map(([s, n]) => `${s}:${n}`)
    .join(", ");
}
