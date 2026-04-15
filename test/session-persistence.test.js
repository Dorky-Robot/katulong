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
    this.id = options.id || null;
    this.tmuxPane = options.tmuxPane || null;
    this._alive = true;
    this._cols = 0;
    this._rows = 0;
    this._resizeCalls = [];
    this.outputBuffer = { totalBytes: 0 };
    this.external = options.external || false;
    this.meta = (options.meta && typeof options.meta === "object" && !Array.isArray(options.meta))
      ? { ...options.meta } : {};
    this._onChange = options.onChange || null;
  }
  get alive() { return this._alive; }
  attachControlMode(/* cols, rows */) { /* Real Session does NOT set _cols here */ }
  async seedScreen() {}
  updateChildCount() {}
  write() {}
  resize(cols, rows) { this._resizeCalls.push({ cols, rows }); this._cols = cols; this._rows = rows; }
  detach() { this._alive = false; }
  kill() { this._alive = false; tmuxSessions.delete(this.tmuxName); }
  serializeScreen() { return ""; }
  setMeta(ns, value) {
    const next = { ...this.meta };
    if (value === null || value === undefined) delete next[ns];
    else next[ns] = value;
    this.meta = next;
    if (this._onChange) this._onChange(this);
  }
  toJSON() {
    return { id: this.id, name: this.name, alive: this.alive, meta: this.meta };
  }
}

mock.module(sessionModuleUrl, {
  namedExports: { Session: MockSession },
});

mock.module(tmuxModuleUrl, {
  namedExports: {
    tmuxExec: async () => ({ code: 0 }),
    tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureVisiblePane: async () => "$ prompt\n",
    checkTmux: async () => {},
    getPaneCwd: async () => "/tmp",
    cleanTmuxServerEnv: async () => {},
    setTmuxKatulongEnv: async () => {},
    tmuxListSessions: async () => [...tmuxSessions.keys()],
    tmuxKillSession: async (tmuxName) => { tmuxSessions.delete(tmuxName); },
    tmuxListSessionsDetailed: async () => new Map(),
    getCursorPosition: async () => ({ row: 0, col: 0 }),
    tmuxSocketArgs: () => [],
    tmuxGetPaneId: async () => "%1",
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
    const a = await mgr1.createSession("my session", 80, 24);
    const b = await mgr1.createSession("dev.server", 80, 24);
    mgr1.shutdown();

    // Verify file was written — new shape is { tmuxName, id, tmuxPane }.
    // tmuxName is `kat_<id>` for new spawns (MC1e PR2).
    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["my session"].tmuxName, `kat_${a.id}`);
    assert.strictEqual(saved["dev.server"].tmuxName, `kat_${b.id}`);
    assert.strictEqual(saved["my session"].id, a.id);
    assert.strictEqual(saved["dev.server"].id, b.id);

    // tmux sessions still exist (shutdown detaches, doesn't kill)
    // Re-add them to our mock since MockSession.detach doesn't remove from tmuxSessions
    tmuxSessions.set(`kat_${a.id}`, true);
    tmuxSessions.set(`kat_${b.id}`, true);

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
    const first = await mgr.createSession("first", 80, 24);
    const second = await mgr.createSession("second", 80, 24);

    // Wait for debounce to fire (100ms + buffer)
    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["first"].tmuxName, `kat_${first.id}`);
    assert.strictEqual(saved["second"].tmuxName, `kat_${second.id}`);

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves after delete and rename", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    const alpha = await mgr.createSession("alpha", 80, 24);
    await mgr.createSession("beta", 80, 24);

    // Delete one
    mgr.deleteSession("beta");
    // Rename the other — MC1e PR2: rename only changes the friendly key,
    // tmuxName stays at kat_<id> (stable).
    await mgr.renameSession("alpha", "omega");

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["omega"].tmuxName, `kat_${alpha.id}`);
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

  it("restored sessions are NOT forcibly resized to DEFAULT_COLS", async () => {
    // Simulate a session that was saved with non-default cols (e.g. 120 cols from a wide client)
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify({ "wide-session": "wide_session" }),
    );
    tmuxSessions.set("wide_session", true);

    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.restoreSessions();

    // Get the restored session and verify it was NOT resized
    const session = mgr.getSession("wide-session");
    assert.ok(session, "Session should be restored");
    assert.strictEqual(session._resizeCalls.length, 0,
      "Restored session should NOT be forcibly resized — clients will send their own dimensions on attach");

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("restored sessions keep whatever dimensions they had from adoptSession", async () => {
    // Two sessions with different column widths
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify({ "narrow": "narrow", "wide": "wide" }),
    );
    tmuxSessions.set("narrow", true);
    tmuxSessions.set("wide", true);

    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.restoreSessions();

    const narrow = mgr.getSession("narrow");
    const wide = mgr.getSession("wide");
    assert.ok(narrow, "Narrow session should be restored");
    assert.ok(wide, "Wide session should be restored");

    // Neither session should have any resize calls after restore
    assert.strictEqual(narrow._resizeCalls.length, 0,
      "Narrow session should NOT be forcibly resized");
    assert.strictEqual(wide._resizeCalls.length, 0,
      "Wide session should NOT be forcibly resized");

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists user/system meta but strips the claude namespace", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.createSession("with-meta", 80, 24);
    const session = mgr.getSession("with-meta");
    session.setMeta("user", { note: "hi" });
    session.setMeta("claude", { uuid: "uuid-live-only" });

    // Wait for debounced save
    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.deepStrictEqual(saved["with-meta"].meta, { user: { note: "hi" } });
    assert.strictEqual(saved["with-meta"].meta.claude, undefined);

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("round-trips persisted meta through restore (minus claude)", async () => {
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify({
        "alpha": {
          tmuxName: "kat_alpha",
          id: "aaaaaaaaaaaaaaaaaaaaa",
          tmuxPane: "%1",
          meta: {
            user: { note: "keeps" },
            claude: { uuid: "should-be-dropped" },
          },
        },
      }),
    );
    tmuxSessions.set("kat_alpha", true);

    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.restoreSessions();

    const alpha = mgr.getSession("alpha");
    assert.ok(alpha, "alpha should be restored");
    assert.deepStrictEqual(alpha.meta, { user: { note: "keeps" } });

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("omits the meta field from sessions.json when the bucket is empty", async () => {
    const mgr = createSessionManager({
      bridge: makeBridge(), shell: "/bin/sh", home: "/tmp", dataDir,
    });
    await mgr.createSession("empty-meta", 80, 24);

    await new Promise((r) => setTimeout(r, 200));

    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(saved["empty-meta"], "meta"), false);

    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
