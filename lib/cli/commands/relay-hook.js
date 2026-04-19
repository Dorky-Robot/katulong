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
import { execFileSync } from "node:child_process";
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

// Resolve the current tmux pane id for stamping onto a hook payload.
//
// Prefer `process.env.TMUX_PANE`: tmux sets this on the shell that owns
// the pane, the shell exports it, claude inherits it, and the hook
// subprocess inherits it from claude. For a hook firing in pane %80,
// $TMUX_PANE in that subprocess is always "%80".
//
// `tmux display-message -p '#{pane_id}'` (without an explicit -t) was
// tried first and is a trap: without a client context, tmux resolves
// the target to the most-recently-active pane *at the server level*,
// not the calling process's pane. When two Claude sessions run side-by-
// side on the same tmux server, every hook event gets stamped with the
// user's most-recently-active pane — the other session's uuid never
// lands, and its sparkle never lights up. See: session-mo2o3gtc on
// %80 whose SessionStart hooks all resolved to %78 (the active
// orchestrator pane) before this fix.
//
// display-message only runs as a last-resort fallback when the env var
// is missing or malformed — a defensive path for hooks spawned outside
// a shell pane (which shouldn't really happen in practice).
function resolveTmuxPane() {
  const envPane = process.env.TMUX_PANE;
  if (envPane && /^%\d+$/.test(envPane)) return envPane;

  const tmuxSocket = process.env.TMUX;
  if (!tmuxSocket) return null;
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
    if (/^%\d+$/.test(out)) return out;
  } catch {
    // tmux missing or unreachable
  }
  return null;
}

// Stamps `_tmuxPane` onto the payload when the hook is firing from inside a
// tmux pane. The server uses this as the middle key that ties a Claude
// session UUID back to the katulong-managed tile running it (see
// docs/tile-claude-session-link.md). The server re-validates this against
// its own pane index before trusting it — a bogus value is a no-op, not a
// privilege escalation.
//
// Exported for tests; pass an explicit `pane` to avoid dependence on live
// tmux state leaking between cases.
export function stampTmuxPane(payload, pane = resolveTmuxPane()) {
  if (!pane || !/^%\d+$/.test(pane)) return payload;
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return payload;
    obj._tmuxPane = pane;
    return JSON.stringify(obj);
  } catch {
    return payload;
  }
}

export default async function relayHook(_args) {
  // Read payload from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (!raw.trim()) process.exit(0);

  const payload = stampTmuxPane(raw);

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
