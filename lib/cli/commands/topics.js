/**
 * CLI: katulong topics
 *
 * List active pub/sub topics and subscriber counts.
 */

import { ensureRunning, api } from "../api-client.js";

export default async function topics(args) {
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
