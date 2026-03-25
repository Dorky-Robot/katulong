/**
 * CLI: katulong attach <name> [-- <command>]
 *
 * Opens a terminal tab in connected browser clients. Creates the
 * session if it doesn't exist. Optionally runs a command in it.
 *
 * Examples:
 *   katulong attach myapp
 *   katulong attach logs -- tail -f /var/log/app.log
 */

import { ensureRunning, api } from "../api-client.js";

export default async function attach(args) {
  // Split on -- to separate attach args from the command to run
  const ddIdx = args.indexOf("--");
  const attachArgs = ddIdx >= 0 ? args.slice(0, ddIdx) : args;
  const command = ddIdx >= 0 ? args.slice(ddIdx + 1).join(" ") : undefined;

  const name = attachArgs.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Usage: katulong attach <session-name> [-- <command>]");
    process.exit(1);
  }

  ensureRunning();

  try {
    const body = { name };
    if (command) body.command = command;
    const result = await api.post("/attach", body);
    const parts = [`✓ ${result.created ? "Created" : "Opened"}: ${result.name}`];
    if (command) parts.push(`→ ${command}`);
    console.log(parts.join("  "));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
