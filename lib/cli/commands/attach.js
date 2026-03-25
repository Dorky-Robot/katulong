/**
 * CLI: katulong attach <name>
 *
 * Opens a terminal tab in connected browser clients. Creates the
 * session if it doesn't exist. Runs from within any katulong terminal.
 */

import { ensureRunning, api } from "../api-client.js";

export default async function attach(args) {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Usage: katulong attach <session-name>");
    process.exit(1);
  }

  ensureRunning();

  try {
    const result = await api.post("/attach", { name });
    console.log(`✓ ${result.created ? "Created" : "Opened"}: ${result.name}`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
