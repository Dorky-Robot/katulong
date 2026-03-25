/**
 * CLI: katulong pub <topic> [message]
 *
 * Publish a message to a topic. Reads from stdin if no message provided.
 */

import { ensureRunning, api } from "../api-client.js";

export default async function pub(args) {
  const topic = args[0];
  if (!topic || topic.startsWith("--")) {
    console.error("Usage: katulong pub <topic> [message]");
    process.exit(1);
  }

  let message = args.slice(1).join(" ");

  // Read from stdin if no message argument
  if (!message) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    message = Buffer.concat(chunks).toString().trim();
  }

  if (!message) {
    console.error("Error: no message provided");
    process.exit(1);
  }

  ensureRunning();

  try {
    const result = await api.post("/pub", { topic, message });
    console.log(`✓ Published to ${topic} (${result.delivered} subscriber${result.delivered !== 1 ? "s" : ""})`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
