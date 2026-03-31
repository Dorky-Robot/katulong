/**
 * Session Persistence Tests
 *
 * Tests save/restore of the friendly-name-to-tmux-name session map
 * across server restarts.
 */

import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock tmux operations before importing session-manager
const tmuxSessions = new Map(); // tmuxName -> true

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const tmuxModuleUrl = new URL("../lib/tmux.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

// Minimal Session mock
class MockSession {
  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this._alive = true;
    this.outputBuffer = { totalBytes: 0 };
    this.external = options.external || false;
  }
  get alive() { return this._alive; }
  attachControlMode() {}
  updateChildCount() {}
  write() {}
  resize() {}
  detach() { this._alive = false; }
  kill() { this._alive = false; tmuxSessions.delete(this.tmuxName); }
  serializeScreen() { return ""; }
  toJSON() { return { name: this.name, alive: this.alive }; }
}

mock.module(sessionModuleUrl, {
  namedExports: { Session: MockSession },
});

mock.module(tmuxModuleUrl, {
  namedExports: {
    tmuxSessionName: (name) => name.replace(/[.: ]/g, "_"),
    tmuxExec: async (args) => {
      if (args[0] === "rename-session") {
        const oldName = args[2];
        const newName = args[3];
        if (tmuxSessions.has(oldName)) {
          tmuxSessions.delete(oldName);
          tmuxSessions.set(newName, true);
          return { code: 0 };
        }
        return { code: 1 };
      }
      return { code: 0 };
    },
    tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureScrollback: async () => "",
    captureVisiblePane: async () => "$ prompt\n",
    checkTmux: async () => {},
    getPaneCwd: async () => "/tmp",
    cleanTmuxServerEnv: async () => {},
    setTmuxKatulongEnv: async () => {},
    tmuxListSessions: async () => [...tmuxSessions.keys()],
    tmuxKillSession: async (tmuxName) => { tmuxSessions.delete(tmuxName); },
    tmuxListSessionsDetailed: async () => new Map(),
    getCursorPosition: async () => ({ row: 0, col: 0 }),
  },
});

mock.module(envFilterUrl, {
  namedExports: { getSafeEnv: () => ({}) },
});

const { createSessionManager } = await import("../lib/session-manager.js");

function makeBridge() {
  const messages = [];
  return { relay(msg) { messages.push(msg); }, register() {}, messages };
}

describe("Session persistence", () => {
  let dataDir;

  beforeEach(() => {
    tmuxSessions.clear();
    dataDir = mkdtempSync(join(tmpdir(), "katulong-persist-test-"));
  });

  it("saves session map on shutdown and restores on startup", async () => {
    // Create a manager, add sessions, then shut down
    const mgr1 = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr1.createSession("my session", 80, 24);
    await mgr1.createSession("dev.server", 80, 24);
    mgr1.shutdown();

    // Verify file was written
    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["my session"], "my_session");
    assert.strictEqual(saved["dev.server"], "dev_server");

    // tmux sessions still exist (shutdown detaches, doesn't kill)
    // Re-add them to our mock since MockSession.detach doesn't remove from tmuxSessions
    tmuxSessions.set("my_session", true);
    tmuxSessions.set("dev_server", true);

    // Create a new manager and restore
    const mgr2 = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr2.restoreSessions();

    const list = mgr2.listSessions();
    const names = list.sessions.map(s => s.name).sort();
    assert.deepStrictEqual(names, ["dev.server", "my session"]);

    mgr2.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("skips sessions whose tmux session no longer exists", async () => {
    // Write a sessions.json with a session that won't exist in tmux
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify({ "gone session": "gone_session", "alive": "alive" }),
    );
    tmuxSessions.set("alive", true);
    // "gone_session" is NOT in tmuxSessions

    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.restoreSessions();

    const list = mgr.listSessions();
    assert.strictEqual(list.sessions.length, 1);
    assert.strictEqual(list.sessions[0].name, "alive");

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("handles missing sessions.json gracefully", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    // No sessions.json exists — should not throw
    await mgr.restoreSessions();
    assert.strictEqual(mgr.listSessions().sessions.length, 0);
    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("handles corrupt sessions.json gracefully", async () => {
    writeFileSync(join(dataDir, "sessions.json"), "not valid json{{{");

    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.restoreSessions();
    assert.strictEqual(mgr.listSessions().sessions.length, 0);
    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("debounced save does not lose data", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.createSession("first", 80, 24);
    await mgr.createSession("second", 80, 24);

    // Wait for debounce to fire (100ms + buffer)
    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["first"], "first");
    assert.strictEqual(saved["second"], "second");

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves after delete and rename", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.createSession("alpha", 80, 24);
    await mgr.createSession("beta", 80, 24);

    // Delete one
    mgr.deleteSession("beta");
    // Rename the other
    await mgr.renameSession("alpha", "omega");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["omega"], "omega");
    assert.strictEqual(saved["beta"], undefined);
    assert.strictEqual(saved["alpha"], undefined);

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("works without dataDir (no persistence)", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp",
    });
    await mgr.createSession("test", 80, 24);
    // Should not throw when no dataDir
    mgr.shutdown();
    await mgr.restoreSessions();
  });
});
