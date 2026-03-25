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
      console.log(`  ${t.name.padEnd(30)} ${t.subscribers} subscriber${t.subscribers !== 1 ? "s" : ""}`);
    }
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
