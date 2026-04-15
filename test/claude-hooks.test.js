import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module reads ~/.claude; override HOME so the tests hit a temp dir
// instead of the developer's real settings file.
describe("claude-hooks (via $HOME override)", () => {
  let tmpHome;
  let originalHome;
  let hooks;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "katulong-claude-hooks-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Fresh import per test so the captured CLAUDE_DIR picks up the new HOME.
    const mod = await import(`../lib/claude-hooks.js?t=${Date.now()}`);
    hooks = mod;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports not-installed on a fresh machine", () => {
    const status = hooks.getClaudeHooksStatus();
    assert.equal(status.installed, false);
    assert.equal(status.partiallyInstalled, false);
    assert.equal(status.missingEvents.length, hooks.HOOK_EVENTS.length);
  });

  it("installs every required event on first run", () => {
    const result = hooks.installClaudeHooks();
    assert.equal(result.installed, true);
    assert.deepEqual(result.added.sort(), [...hooks.HOOK_EVENTS].sort());
    const status = hooks.getClaudeHooksStatus();
    assert.equal(status.installed, true);
    assert.equal(status.missingEvents.length, 0);
  });

  it("is idempotent — running install twice is a no-op", () => {
    hooks.installClaudeHooks();
    const second = hooks.installClaudeHooks();
    assert.equal(second.installed, true);
    assert.equal(second.added.length, 0);
    assert.equal(second.alreadyInstalled.length, hooks.HOOK_EVENTS.length);
  });

  it("tops up a partially installed settings file without clobbering other hooks", () => {
    // Seed a partial install with an unrelated user hook present.
    const settings = {
      hooks: {
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "katulong relay-hook" }] },
        ],
        UserCustom: [
          { matcher: "*", hooks: [{ type: "command", command: "/some/other/tool" }] },
        ],
      },
    };
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(join(tmpHome, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2));

    const result = hooks.installClaudeHooks();
    assert.equal(result.installed, true);
    // Every event except PostToolUse should be newly added.
    assert.ok(result.added.length > 0);
    assert.ok(!result.added.includes("PostToolUse"));
    assert.ok(result.alreadyInstalled.includes("PostToolUse"));

    // User's unrelated hook must survive.
    const onDisk = JSON.parse(readFileSync(join(tmpHome, ".claude", "settings.local.json"), "utf8"));
    assert.ok(onDisk.hooks.UserCustom);
    assert.equal(onDisk.hooks.UserCustom[0].hooks[0].command, "/some/other/tool");
  });

  it("removes only katulong relay hooks, leaving user hooks alone", () => {
    hooks.installClaudeHooks();
    // Add a user hook alongside the katulong one.
    const settingsPath = join(tmpHome, ".claude", "settings.local.json");
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    s.hooks.PostToolUse.push({
      matcher: "*",
      hooks: [{ type: "command", command: "/some/user/hook" }],
    });
    writeFileSync(settingsPath, JSON.stringify(s, null, 2));

    const result = hooks.removeClaudeHooks();
    assert.ok(result.removed.length > 0);
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf8"));
    // User hook survives; katulong relay is gone.
    const postToolUse = onDisk.hooks?.PostToolUse || [];
    const hasRelay = postToolUse.some((g) =>
      g.hooks?.some((h) => h.command === "katulong relay-hook")
    );
    const hasUser = postToolUse.some((g) =>
      g.hooks?.some((h) => h.command === "/some/user/hook")
    );
    assert.equal(hasRelay, false);
    assert.equal(hasUser, true);
  });

  it("strips stale http hooks pointing at the old claude-events url", () => {
    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "http", url: "http://localhost:3000/api/claude-events" }],
          },
        ],
      },
    };
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(join(tmpHome, ".claude", "settings.local.json"), JSON.stringify(settings, null, 2));

    hooks.installClaudeHooks();
    const onDisk = JSON.parse(readFileSync(join(tmpHome, ".claude", "settings.local.json"), "utf8"));
    const postToolUse = onDisk.hooks.PostToolUse;
    // Old http hook is gone, new relay-hook is present.
    const hasOldHttp = postToolUse.some((g) =>
      g.hooks?.some((h) => h.url && h.url.includes("/api/claude-events"))
    );
    const hasRelay = postToolUse.some((g) =>
      g.hooks?.some((h) => h.command === "katulong relay-hook")
    );
    assert.equal(hasOldHttp, false);
    assert.equal(hasRelay, true);
  });
});
