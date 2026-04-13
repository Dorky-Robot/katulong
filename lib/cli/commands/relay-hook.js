/**
 * CLI: katulong relay-hook
 *
 * Reads a Claude Code hook payload from stdin and POSTs it to the
 * running katulong server's /api/claude-events endpoint.
 *
 * Resolves the server URL dynamically:
 *   1. ~/.katulong/server.json (localhost — no auth needed)
 *   2. ~/.katulong/remote.json (tunnel URL — uses API key Bearer auth)
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

const REMOTE_PATH = join(envConfig.dataDir, "remote.json");

function readRemoteConfig() {
  try {
    const data = JSON.parse(readFileSync(REMOTE_PATH, "utf8"));
    if (data.url && data.apiKey) return data;
    return null;
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
    const url = `http://localhost:${serverInfo.port}/api/claude-events`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) process.exit(0);
    } catch {
      // Local server unreachable — fall through to remote
    }
  }

  // Fall back to remote (tunnel URL + API key)
  const remote = readRemoteConfig();
  if (remote) {
    try {
      await fetch(`${remote.url}/api/claude-events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${remote.apiKey}`,
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Silent failure — hooks must not block Claude
    }
  }
}
