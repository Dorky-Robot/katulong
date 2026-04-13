/**
 * CLI: katulong relay-hook
 *
 * Reads a Claude Code hook payload from stdin and POSTs it to the
 * running katulong server's /api/claude-events endpoint.
 *
 * Resolves the server URL dynamically:
 *   1. ~/.katulong/server.json  → localhost (no auth needed)
 *   2. ~/.katulong/config.json  → publicUrl (self-access URL, needs API key)
 *
 * Designed for use as a Claude Code command hook:
 *   { "type": "command", "command": "katulong relay-hook" }
 *
 * Exits silently on any error — hooks must never block Claude.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readServerInfo } from "../process-manager.js";
import envConfig from "../../env-config.js";

const DATA_DIR = envConfig.dataDir;

function readConfig(key) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"))[key] || null;
  } catch {
    return null;
  }
}

function readApiKey() {
  try {
    const data = JSON.parse(readFileSync(join(DATA_DIR, "remote.json"), "utf8"));
    return data.apiKey || null;
  } catch {
    return null;
  }
}

export default async function relayHook(_args) {
  // Read payload from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = Buffer.concat(chunks).toString();
  if (!payload.trim()) process.exit(0);

  // Try local server first (localhost — auth bypassed automatically)
  const serverInfo = readServerInfo();
  if (serverInfo) {
    try {
      const res = await fetch(`http://localhost:${serverInfo.port}/api/claude-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) process.exit(0);
    } catch {
      // Local server unreachable — fall through
    }
  }

  // Fall back to publicUrl from config.json (self-access URL)
  const publicUrl = readConfig("publicUrl");
  const apiKey = readApiKey();
  if (publicUrl && apiKey) {
    try {
      await fetch(`${publicUrl}/api/claude-events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Silent failure — hooks must not block Claude
    }
  }
}
