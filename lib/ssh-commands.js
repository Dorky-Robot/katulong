/**
 * SSH CLI Command System
 *
 * Dispatches `katulong <subcommand>` commands over SSH exec requests.
 * SSH users are already password-authenticated — no additional auth needed.
 */

import { randomBytes } from "node:crypto";
import { log } from "./log.js";
import { AuthState } from "./auth-state.js";
import { SETUP_TOKEN_TTL_MS } from "./env-config.js";

/**
 * Parse a command string into tokens, handling quoted arguments.
 * @param {string} str - Raw command string
 * @returns {string[]} Tokens
 */
export function parseCommand(str) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Format a table with column-aligned text output.
 * @param {string[]} headers - Column headers
 * @param {Array<string[]>} rows - Row data
 * @returns {string} Formatted table
 */
export function formatTable(headers, rows) {
  if (rows.length === 0) {
    return headers.join("  ") + "\n(none)\n";
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, String(row[i] || "").length), 0);
    return Math.max(h.length, dataMax);
  });

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const separator = widths.map(w => "-".repeat(w)).join("  ");
  const dataLines = rows.map(row =>
    row.map((cell, i) => String(cell || "").padEnd(widths[i])).join("  ")
  );

  return [headerLine, separator, ...dataLines].join("\n") + "\n";
}

/**
 * Build a command response, choosing JSON or text output based on --json flag.
 * @param {object} data - Data for JSON output
 * @param {string} text - Text for human-readable output
 * @param {string[]} args - Command args (checked for --json)
 * @param {number} exitCode - Exit code
 * @returns {{output: string, exitCode: number}}
 */
function respond(data, text, args, exitCode = 0) {
  const output = args.includes("--json")
    ? JSON.stringify(data, null, 2) + "\n"
    : text;
  return { output, exitCode };
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatExpiry(timestamp) {
  if (!timestamp) return "none";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// --- Command handlers ---

async function tokenCreate(args, ctx) {
  const name = args.filter(a => a !== "--json").join(" ");
  if (!name) {
    return { output: "Usage: katulong token create <name>\n", exitCode: 1 };
  }

  const { tokenData } = await ctx.withStateLock((state) => {
    const now = Date.now();
    const tokenData = {
      id: randomBytes(8).toString("hex"),
      token: randomBytes(16).toString("hex"),
      name: name.trim(),
      createdAt: now,
      lastUsedAt: null,
      expiresAt: now + SETUP_TOKEN_TTL_MS,
    };
    const newState = (state || AuthState.empty()).addSetupToken(tokenData);
    return { state: newState, tokenData };
  });

  log.info("Setup token created via SSH", { id: tokenData.id, name: tokenData.name });

  return respond(
    { id: tokenData.id, name: tokenData.name, token: tokenData.token, createdAt: tokenData.createdAt, expiresAt: tokenData.expiresAt },
    `Token created:\n  ID:      ${tokenData.id}\n  Name:    ${tokenData.name}\n  Token:   ${tokenData.token}\n  Expires: ${formatExpiry(tokenData.expiresAt)}\n\nSave this token — it will not be shown again.\n`,
    args,
  );
}

async function tokenList(args, ctx) {
  const state = ctx.loadState();
  if (!state) return respond({ tokens: [] }, "No tokens.\n", args);

  const tokens = state.setupTokens.map(t => {
    const credential = t.credentialId ? state.getCredential(t.credentialId) : null;
    return {
      id: t.id,
      name: t.name,
      expiresAt: t.expiresAt || null,
      credentialName: credential ? credential.name : null,
    };
  });

  if (tokens.length === 0) return respond({ tokens: [] }, "No tokens.\n", args);

  return respond(
    { tokens },
    formatTable(["ID", "NAME", "EXPIRES", "CREDENTIAL"], tokens.map(t => [t.id, t.name, formatExpiry(t.expiresAt), t.credentialName || "-"])),
    args,
  );
}

async function tokenRevoke(args, ctx) {
  const id = args.find(a => a !== "--json");
  if (!id) {
    return { output: "Usage: katulong token revoke <id>\n", exitCode: 1 };
  }

  const result = await ctx.withStateLock((state) => {
    if (!state) return { found: false };
    const token = state.setupTokens.find(t => t.id === id);
    if (!token) return { found: false };

    let updatedState = state;
    let removedCredentialId = null;

    if (token.credentialId) {
      const credential = state.getCredential(token.credentialId);
      if (credential) {
        updatedState = updatedState.removeCredential(token.credentialId, { allowRemoveLast: true });
        removedCredentialId = token.credentialId;
      }
    }
    updatedState = updatedState.removeSetupToken(id);
    return { state: updatedState, found: true, removedCredentialId };
  });

  if (!result.found) return respond({ error: "Token not found" }, "Token not found.\n", args, 1);

  log.info("Setup token revoked via SSH", { id, credentialRevoked: !!result.removedCredentialId });

  return respond(
    { ok: true, credentialRevoked: !!result.removedCredentialId },
    result.removedCredentialId ? "Token and linked credential revoked.\n" : "Token revoked.\n",
    args,
  );
}

async function credentialList(args, ctx) {
  const state = ctx.loadState();
  if (!state) return respond({ credentials: [] }, "No credentials.\n", args);

  const credentials = state.credentials.map(c => ({
    id: c.id,
    name: c.name || "Unknown",
    createdAt: c.createdAt || null,
    lastUsedAt: c.lastUsedAt || null,
  }));

  if (credentials.length === 0) return respond({ credentials: [] }, "No credentials.\n", args);

  return respond(
    { credentials },
    formatTable(["ID", "NAME", "CREATED", "LAST USED"], credentials.map(c => [c.id, c.name, formatRelativeTime(c.createdAt), formatRelativeTime(c.lastUsedAt)])),
    args,
  );
}

async function credentialRevoke(args, ctx) {
  const id = args.find(a => a !== "--json");
  if (!id) {
    return { output: "Usage: katulong credential revoke <id>\n", exitCode: 1 };
  }

  try {
    const result = await ctx.withStateLock((state) => {
      if (!state) return { found: false };
      const credential = state.getCredential(id);
      if (!credential) return { found: false };
      const updatedState = state.removeCredential(id, { allowRemoveLast: true });
      return { state: updatedState, found: true };
    });

    if (!result.found) return respond({ error: "Credential not found" }, "Credential not found.\n", args, 1);
  } catch (err) {
    return respond({ error: err.message }, `Error: ${err.message}\n`, args, 1);
  }

  log.info("Credential revoked via SSH", { id });
  return respond({ ok: true }, "Credential revoked.\n", args);
}

async function sessionList(args, ctx) {
  try {
    const result = await ctx.daemonRPC({ type: "list-sessions" });
    const sessions = result.sessions || [];
    if (sessions.length === 0) return respond({ sessions: [] }, "No active sessions.\n", args);
    return respond(
      { sessions },
      formatTable(["NAME", "CLIENTS", "ALIVE"], sessions.map(s => [s.name, String(s.clients || 0), s.alive ? "yes" : "no"])),
      args,
    );
  } catch (err) {
    return respond({ error: err.message }, `Error: ${err.message}\n`, args, 1);
  }
}

async function sessionCreate(args, ctx) {
  const name = args.filter(a => a !== "--json").join(" ");
  if (!name) {
    return { output: "Usage: katulong session create <name>\n", exitCode: 1 };
  }

  try {
    const result = await ctx.daemonRPC({ type: "create-session", name });
    if (result.error) return respond({ error: result.error }, `Error: ${result.error}\n`, args, 1);
    return respond({ name: result.name }, `Session "${result.name}" created.\n`, args);
  } catch (err) {
    return respond({ error: err.message }, `Error: ${err.message}\n`, args, 1);
  }
}

async function sessionKill(args, ctx) {
  const name = args.find(a => a !== "--json");
  if (!name) {
    return { output: "Usage: katulong session kill <name>\n", exitCode: 1 };
  }

  try {
    const result = await ctx.daemonRPC({ type: "delete-session", name });
    if (result.error) return respond({ error: result.error }, `Error: ${result.error}\n`, args, 1);
    return respond({ ok: true }, `Session "${name}" killed.\n`, args);
  } catch (err) {
    return respond({ error: err.message }, `Error: ${err.message}\n`, args, 1);
  }
}

async function sessionRename(args, ctx) {
  const filtered = args.filter(a => a !== "--json");
  if (filtered.length < 2) {
    return { output: "Usage: katulong session rename <old> <new>\n", exitCode: 1 };
  }
  const [oldName, newName] = filtered;

  try {
    const result = await ctx.daemonRPC({ type: "rename-session", oldName, newName });
    if (result.error) return respond({ error: result.error }, `Error: ${result.error}\n`, args, 1);
    return respond({ name: result.name }, `Session renamed to "${result.name}".\n`, args);
  } catch (err) {
    return respond({ error: err.message }, `Error: ${err.message}\n`, args, 1);
  }
}

async function statusCommand(args, ctx) {
  const state = ctx.loadState();
  const credentialCount = state ? state.credentials.length : 0;
  const tokenCount = state ? state.setupTokens.length : 0;
  const sessionCount = state ? Object.keys(state.sessions).length : 0;

  let daemonStatus = "unknown";
  let ptySessions = 0;
  try {
    const result = await ctx.daemonRPC({ type: "list-sessions" });
    daemonStatus = "connected";
    ptySessions = (result.sessions || []).length;
  } catch {
    daemonStatus = "disconnected";
  }

  const data = {
    credentials: credentialCount,
    setupTokens: tokenCount,
    authSessions: sessionCount,
    ptySessions,
    daemon: daemonStatus,
  };

  return respond(data, [
    `Credentials:    ${credentialCount}`,
    `Setup tokens:   ${tokenCount}`,
    `Auth sessions:  ${sessionCount}`,
    `PTY sessions:   ${ptySessions}`,
    `Daemon:         ${daemonStatus}`,
    "",
  ].join("\n"), args);
}

function helpCommand(_args, _ctx) {
  return {
    output: [
      "Usage: katulong <command> [args] [--json]",
      "",
      "Token management:",
      "  token create <name>       Create a setup token (shown once)",
      "  token list                List setup tokens",
      "  token revoke <id>         Revoke a token (and linked credential)",
      "",
      "Credential management:",
      "  credential list           List registered passkeys",
      "  credential revoke <id>    Revoke a passkey",
      "",
      "Session management:",
      "  session list              List active PTY sessions",
      "  session create <name>     Create a new PTY session",
      "  session kill <name>       Kill a PTY session",
      "  session rename <old> <new> Rename a PTY session",
      "",
      "Utility:",
      "  status                    Show system status",
      "  help                      Show this help message",
      "",
    ].join("\n"),
    exitCode: 0,
  };
}

// --- Handler map ---

const handlers = {
  "token create": tokenCreate,
  "token list": tokenList,
  "token revoke": tokenRevoke,
  "credential list": credentialList,
  "credential revoke": credentialRevoke,
  "session list": sessionList,
  "session create": sessionCreate,
  "session kill": sessionKill,
  "session rename": sessionRename,
  status: statusCommand,
  help: helpCommand,
};

/**
 * Execute a katulong command.
 *
 * @param {string} str - Full command string (e.g. "katulong token create 'My Phone'")
 * @param {object} ctx - Context with loadState, withStateLock, daemonRPC
 * @returns {Promise<{output: string, exitCode: number}|null>} Result or null if not a katulong command
 */
export async function executeCommand(str, ctx) {
  const tokens = parseCommand(str.trim());
  if (tokens.length === 0 || tokens[0] !== "katulong") {
    return null;
  }

  if (tokens.length === 1) {
    return helpCommand([], ctx);
  }

  // Try two-word command first (e.g. "token create"), then one-word (e.g. "help")
  const twoWord = `${tokens[1]} ${tokens[2] || ""}`.trim();
  const oneWord = tokens[1];

  if (handlers[twoWord]) {
    const args = tokens.slice(3);
    return handlers[twoWord](args, ctx);
  }

  if (handlers[oneWord]) {
    const args = tokens.slice(2);
    return handlers[oneWord](args, ctx);
  }

  return {
    output: `Unknown command: ${oneWord}\nRun "katulong help" for available commands.\n`,
    exitCode: 1,
  };
}
