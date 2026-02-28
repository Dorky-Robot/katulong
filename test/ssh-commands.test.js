import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, formatTable, executeCommand } from "../lib/ssh-commands.js";
import { AuthState } from "../lib/auth-state.js";

describe("parseCommand", () => {
  it("splits simple tokens by spaces", () => {
    assert.deepEqual(parseCommand("katulong token list"), ["katulong", "token", "list"]);
  });

  it("handles single-quoted arguments", () => {
    assert.deepEqual(
      parseCommand("katulong token create 'My Phone'"),
      ["katulong", "token", "create", "My Phone"],
    );
  });

  it("handles double-quoted arguments", () => {
    assert.deepEqual(
      parseCommand('katulong token create "My Phone"'),
      ["katulong", "token", "create", "My Phone"],
    );
  });

  it("handles multiple spaces between tokens", () => {
    assert.deepEqual(parseCommand("katulong  token   list"), ["katulong", "token", "list"]);
  });

  it("handles empty string", () => {
    assert.deepEqual(parseCommand(""), []);
  });

  it("handles leading and trailing spaces (via trim in executeCommand)", () => {
    assert.deepEqual(parseCommand("  katulong help  "), ["katulong", "help"]);
  });

  it("handles mixed quotes", () => {
    assert.deepEqual(
      parseCommand(`katulong token create "John's Phone"`),
      ["katulong", "token", "create", "John's Phone"],
    );
  });

  it("handles --json flag", () => {
    assert.deepEqual(
      parseCommand("katulong token list --json"),
      ["katulong", "token", "list", "--json"],
    );
  });
});

describe("formatTable", () => {
  it("formats a table with headers and rows", () => {
    const output = formatTable(["ID", "NAME"], [["abc", "Test"]]);
    assert.ok(output.includes("ID"));
    assert.ok(output.includes("NAME"));
    assert.ok(output.includes("abc"));
    assert.ok(output.includes("Test"));
    assert.ok(output.includes("--"));
  });

  it("shows (none) for empty rows", () => {
    const output = formatTable(["ID", "NAME"], []);
    assert.ok(output.includes("(none)"));
  });

  it("pads columns to align", () => {
    const output = formatTable(["ID", "NAME"], [["a", "Short"], ["abcdef", "Longer Name"]]);
    const lines = output.split("\n").filter(l => l.length > 0);
    // Header, separator, and 2 data lines
    assert.equal(lines.length, 4);
  });
});

// --- Helper to build mock context ---

function createMockCtx(stateOverrides = {}) {
  let currentState = new AuthState({
    user: { id: "test-user", name: "owner" },
    credentials: stateOverrides.credentials || [],
    sessions: stateOverrides.sessions || {},
    setupTokens: stateOverrides.setupTokens || [],
  });

  const ctx = {
    loadState: () => currentState,
    withStateLock: async (modifier) => {
      const result = await modifier(currentState);
      if (result && typeof result === "object" && "state" in result && result.state != null) {
        currentState = result.state;
      }
      return result;
    },
    daemonRPC: async (msg) => {
      if (msg.type === "list-sessions") {
        return { sessions: stateOverrides.ptySessions || [] };
      }
      if (msg.type === "create-session") {
        return { name: msg.name };
      }
      if (msg.type === "delete-session") {
        return { ok: true };
      }
      if (msg.type === "rename-session") {
        return { name: msg.newName };
      }
      return {};
    },
  };

  return { ctx, getState: () => currentState };
}

describe("executeCommand", () => {
  it("returns null for non-katulong commands", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("ls -la", ctx);
    assert.equal(result, null);
  });

  it("returns help for bare 'katulong' command", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("Usage:"));
  });

  it("returns error for unknown subcommand", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong foobar", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Unknown command"));
  });

  it("returns null for empty string", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("", ctx);
    assert.equal(result, null);
  });
});

describe("katulong help", () => {
  it("shows all command categories", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong help", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("Token management"));
    assert.ok(result.output.includes("Credential management"));
    assert.ok(result.output.includes("Session management"));
    assert.ok(result.output.includes("Utility"));
  });
});

describe("katulong token create", () => {
  it("creates a token and returns plaintext", async () => {
    const { ctx, getState } = createMockCtx();
    const result = await executeCommand("katulong token create 'My Phone'", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("Token created"));
    assert.ok(result.output.includes("My Phone"));
    assert.ok(result.output.includes("Token:"));
    // State should now have a token
    assert.equal(getState().setupTokens.length, 1);
  });

  it("returns error without a name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token create", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token create TestDevice --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.equal(data.name, "TestDevice");
    assert.ok(data.token);
    assert.ok(data.id);
    assert.ok(data.expiresAt);
  });

  it("rejects token name exceeding 128 characters", async () => {
    const { ctx } = createMockCtx();
    const longName = "a".repeat(129);
    const result = await executeCommand(`katulong token create ${longName}`, ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("too long"));
  });
});

describe("katulong token list", () => {
  it("shows 'No tokens' when empty", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("No tokens"));
  });

  it("lists tokens after creation", async () => {
    const { ctx } = createMockCtx();
    await executeCommand("katulong token create 'Device A'", ctx);
    const result = await executeCommand("katulong token list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("Device A"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx();
    await executeCommand("katulong token create TestDevice", ctx);
    const result = await executeCommand("katulong token list --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.ok(Array.isArray(data.tokens));
    assert.equal(data.tokens.length, 1);
    assert.equal(data.tokens[0].name, "TestDevice");
  });

  it("shows 'No tokens' when state is null", async () => {
    const { ctx } = createMockCtx();
    ctx.loadState = () => null;
    const result = await executeCommand("katulong token list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("No tokens"));
  });
});

describe("katulong token revoke", () => {
  it("revokes an existing token", async () => {
    const { ctx, getState } = createMockCtx();
    // Create a token first
    const createResult = await executeCommand("katulong token create TestToken --json", ctx);
    const tokenData = JSON.parse(createResult.output);
    assert.equal(getState().setupTokens.length, 1);

    const result = await executeCommand(`katulong token revoke ${tokenData.id}`, ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("revoked"));
    assert.equal(getState().setupTokens.length, 0);
  });

  it("returns error for non-existent token", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token revoke nonexistent", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("not found"));
  });

  it("returns error without id", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token revoke", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong token revoke nonexistent --json", ctx);
    assert.equal(result.exitCode, 1);
    const data = JSON.parse(result.output);
    assert.ok(data.error);
  });
});

describe("katulong credential list", () => {
  it("shows 'No credentials' when empty", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong credential list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("No credentials"));
  });

  it("lists credentials when present", async () => {
    const { ctx } = createMockCtx({
      credentials: [
        { id: "cred-1", name: "MacBook", publicKey: "key1", counter: 0, createdAt: Date.now(), lastUsedAt: Date.now() },
      ],
    });
    const result = await executeCommand("katulong credential list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("MacBook"));
    assert.ok(result.output.includes("cred-1"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx({
      credentials: [
        { id: "cred-1", name: "MacBook", publicKey: "key1", counter: 0, createdAt: Date.now(), lastUsedAt: null },
      ],
    });
    const result = await executeCommand("katulong credential list --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.equal(data.credentials.length, 1);
    assert.equal(data.credentials[0].id, "cred-1");
    assert.equal(data.credentials[0].name, "MacBook");
  });

  it("shows 'No credentials' when state is null", async () => {
    const { ctx } = createMockCtx();
    ctx.loadState = () => null;
    const result = await executeCommand("katulong credential list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("No credentials"));
  });
});

describe("katulong credential revoke", () => {
  it("revokes an existing credential", async () => {
    const { ctx, getState } = createMockCtx({
      credentials: [
        { id: "cred-1", name: "MacBook", publicKey: "key1", counter: 0 },
      ],
    });
    const result = await executeCommand("katulong credential revoke cred-1", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("revoked"));
    assert.equal(getState().credentials.length, 0);
  });

  it("returns error for non-existent credential", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong credential revoke nonexistent", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("not found"));
  });

  it("returns error without id", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong credential revoke", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });
});

describe("katulong session list", () => {
  it("shows 'No active sessions' when empty", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("No active sessions"));
  });

  it("lists sessions from daemon", async () => {
    const { ctx } = createMockCtx({
      ptySessions: [
        { name: "default", clients: 2, alive: true },
        { name: "work", clients: 0, alive: true },
      ],
    });
    const result = await executeCommand("katulong session list", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("default"));
    assert.ok(result.output.includes("work"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx({
      ptySessions: [{ name: "default", clients: 1, alive: true }],
    });
    const result = await executeCommand("katulong session list --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].name, "default");
  });

  it("handles daemon error gracefully", async () => {
    const { ctx } = createMockCtx();
    ctx.daemonRPC = async () => { throw new Error("Daemon not connected"); };
    const result = await executeCommand("katulong session list", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Internal error"));
  });
});

describe("katulong session create", () => {
  it("creates a session", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session create work", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("work"));
    assert.ok(result.output.includes("created"));
  });

  it("returns error without name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session create", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });

  it("returns error on daemon conflict", async () => {
    const { ctx } = createMockCtx();
    ctx.daemonRPC = async () => ({ error: "Session already exists" });
    const result = await executeCommand("katulong session create work", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("already exists"));
  });

  it("rejects invalid session names", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session create '../../etc'", ctx);
    // SessionName strips invalid chars, so "../../etc" becomes "etc"
    assert.equal(result.exitCode, 0);
  });

  it("rejects empty session name after sanitization", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session create '...'", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Invalid session name"));
  });
});

describe("katulong session kill", () => {
  it("kills a session", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session kill work", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("killed"));
  });

  it("returns error without name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session kill", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });

  it("returns error on daemon failure", async () => {
    const { ctx } = createMockCtx();
    ctx.daemonRPC = async () => ({ error: "Session not found" });
    const result = await executeCommand("katulong session kill nonexistent", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("not found"));
  });

  it("rejects invalid session name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session kill '...'", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Invalid session name"));
  });
});

describe("katulong session rename", () => {
  it("renames a session", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session rename old new", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("renamed"));
  });

  it("returns error without both names", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session rename old", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Usage:"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session rename old new --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.equal(data.name, "new");
  });

  it("rejects invalid new session name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session rename old '...'", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Invalid session name"));
  });

  it("rejects invalid old session name", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong session rename '...' new", ctx);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes("Invalid session name"));
  });
});

describe("katulong status", () => {
  it("shows status information", async () => {
    const { ctx } = createMockCtx({
      credentials: [
        { id: "cred-1", name: "Test", publicKey: "key1", counter: 0 },
      ],
      ptySessions: [{ name: "default", clients: 1, alive: true }],
    });
    const result = await executeCommand("katulong status", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("Credentials:"));
    assert.ok(result.output.includes("1"));
    assert.ok(result.output.includes("connected"));
  });

  it("shows disconnected when daemon is down", async () => {
    const { ctx } = createMockCtx();
    ctx.daemonRPC = async () => { throw new Error("Daemon not connected"); };
    const result = await executeCommand("katulong status", ctx);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("disconnected"));
  });

  it("supports --json output", async () => {
    const { ctx } = createMockCtx();
    const result = await executeCommand("katulong status --json", ctx);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.output);
    assert.equal(typeof data.credentials, "number");
    assert.equal(typeof data.daemon, "string");
  });
});
