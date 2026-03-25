/**
 * CLI: katulong notify <message>
 *
 * Sends a native OS notification to all connected browser clients.
 */

import { ensureRunning, api } from "../api-client.js";

export default async function notify(args) {
  const message = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!message) {
    console.error("Usage: katulong notify <message>");
    process.exit(1);
  }

  const title = args.includes("--title")
    ? args[args.indexOf("--title") + 1]
    : undefined;

  ensureRunning();

  try {
    await api.post("/notify", { message, title });
    console.log("✓ Notification sent");
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
