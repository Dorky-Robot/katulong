/**
 * Session Manager Tests
 *
 * Tests session lifecycle, client tracking, spawn serialization,
 * session limits, and delete/detach behavior.
 *
 * Uses mock.module to replace tmux operations with in-memory stubs.
 */

import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Mock tmux operations before importing session-manager
const tmuxSessions = new Map(); // tmuxName -> true

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

// Minimal Session mock that tracks state
class MockSession {
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

  constructor(name, tmuxName) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.state = MockSession.STATE_ATTACHED;
    this.outputBuffer = [];
    this.lastKnownChildCount = 0;
    this.external = false;
    this._written = [];
    this._resizes = [];
  }

  get alive() { return this.state === MockSession.STATE_ATTACHED; }
  attachControlMode() {}
  write(data) { this._written.push(data); }
  resize(cols, rows) { this._resizes.push({ cols, rows }); }
  detach() {
    if (this.state !== MockSession.STATE_ATTACHED) return;
    this.state = MockSession.STATE_DETACHED;
  }
  kill() {
    if (this.state === MockSession.STATE_KILLED) return;
    this.state = MockSession.STATE_KILLED;
    tmuxSessions.delete(this.tmuxName);
  }
  toJSON() {
    return { name: this.name, alive: this.alive, external: this.external };
  }
}

mock.module(sessionModuleUrl, {
  namedExports: {
    Session: MockSession,
    tmuxSessionName: (name) => name.replace(/[.: ]/g, "_"),
    tmuxExec: async (args) => {
      // Rename support
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
    tmuxNewSession: async (tmuxName) => {
      tmuxSessions.set(tmuxName, true);
    },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureScrollback: async () => "",
    captureVisiblePane: async () => "$ prompt\n",
    checkTmux: async () => {},
    cleanTmuxServerEnv: async () => {},
    tmuxListSessions: async () => [...tmuxSessions.keys()],
    tmuxKillSession: async (tmuxName) => { tmuxSessions.delete(tmuxName); },
    tmuxListSessionsDetailed: async () => new Map(),
  },
});

mock.module(envFilterUrl, {
  namedExports: {
    getSafeEnv: () => ({}),
  },
});

const { createSessionManager } = await import("../lib/session-manager.js");

function makeBridge() {
  const messages = [];
  return {
    relay(msg) { messages.push(msg); },
    register() {},
    messages,
  };
}

function makeManager(overrides = {}) {
  const bridge = makeBridge();
  const mgr = createSessionManager({
    bridge,
    shell: "/bin/sh",
    home: "/tmp",
    ...overrides,
  });
  return { mgr, bridge };
}

describe("session manager", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  describe("createSession", () => {
    it("creates a session and returns its name", async () => {
      const { mgr } = makeManager();
      const result = await mgr.createSession("test1");
      assert.deepStrictEqual(result, { name: "test1" });
    });

    it("rejects duplicate session names", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("dup");
      const result = await mgr.createSession("dup");
      assert.ok(result.error, "Should return an error for duplicate name");
    });

    it("enforces session limit", async () => {
      const { mgr } = makeManager();
      // Create 20 sessions (the max)
      for (let i = 0; i < 20; i++) {
        const r = await mgr.createSession(`s${i}`);
        assert.strictEqual(r.name, `s${i}`);
      }
      // 21st should fail
      const result = await mgr.createSession("s20");
      assert.ok(result.error, "Should reject when at max sessions");
      assert.ok(result.error.includes("Maximum"), "Error should mention the limit");
    });
  });

  describe("listSessions", () => {
    it("returns empty list initially", () => {
      const { mgr } = makeManager();
      const result = mgr.listSessions();
      assert.deepStrictEqual(result.sessions, []);
    });

    it("lists created sessions", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      await mgr.createSession("b");
      const result = mgr.listSessions();
      assert.strictEqual(result.sessions.length, 2);
      const names = result.sessions.map(s => s.name);
      assert.ok(names.includes("a"));
      assert.ok(names.includes("b"));
    });
  });

  describe("deleteSession", () => {
    it("deletes a session", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("del");
      const result = mgr.deleteSession("del");
      assert.deepStrictEqual(result, { ok: true, action: "deleted" });
      assert.strictEqual(mgr.listSessions().sessions.length, 0);

      const removed = bridge.messages.find(m => m.type === "session-removed");
      assert.ok(removed, "Should relay session-removed event");
      assert.strictEqual(removed.session, "del");
    });

    it("detaches a session without killing it", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("detach-me");
      const result = mgr.deleteSession("detach-me", { detachOnly: true });
      assert.deepStrictEqual(result, { ok: true, action: "detached" });
      assert.strictEqual(mgr.listSessions().sessions.length, 0);
      // tmux session should still exist
      assert.ok(tmuxSessions.has("detach-me"), "tmux session should remain after detach");
    });

    it("returns error for nonexistent session", () => {
      const { mgr } = makeManager();
      const result = mgr.deleteSession("nope");
      assert.deepStrictEqual(result, { error: "Not found" });
    });
  });

  describe("renameSession", () => {
    it("renames a session", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("old");
      const result = await mgr.renameSession("old", "new");
      assert.deepStrictEqual(result, { name: "new" });
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
      assert.strictEqual(mgr.listSessions().sessions[0].name, "new");

      const renamed = bridge.messages.find(m => m.type === "session-renamed");
      assert.ok(renamed);
      assert.strictEqual(renamed.session, "old");
      assert.strictEqual(renamed.newName, "new");
    });

    it("rejects rename to existing name", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      await mgr.createSession("b");
      const result = await mgr.renameSession("a", "b");
      assert.ok(result.error);
    });

    it("rejects rename of nonexistent session", async () => {
      const { mgr } = makeManager();
      const result = await mgr.renameSession("nope", "new");
      assert.ok(result.error);
    });
  });

  describe("client attach/detach", () => {
    it("attaches a client to a session and returns visible pane snapshot", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      const result = await mgr.attachClient("client1", "sess", 80, 24);
      assert.strictEqual(result.alive, true);
      assert.strictEqual(result.buffer, "$ prompt\n");
    });

    it("creates session on attach if missing", async () => {
      const { mgr } = makeManager();
      const result = await mgr.attachClient("client1", "auto", 80, 24);
      assert.strictEqual(result.alive, true);
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });

    it("detaches client", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("client1", "sess", 80, 24);
      mgr.detachClient("client1");
      // No error — detach is fire-and-forget
    });
  });

  describe("writeInput", () => {
    it("writes to attached session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("c1", "sess", 80, 24);
      mgr.writeInput("c1", "hello");
      // No error means success — mock captures writes
    });

    it("no-ops for unknown client", () => {
      const { mgr } = makeManager();
      mgr.writeInput("unknown", "data");
      // Should not throw
    });
  });

  describe("killTmuxSession", () => {
    it("rejects killing a managed session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("managed");
      const result = await mgr.killTmuxSession("managed");
      assert.ok(result.error);
      assert.ok(result.error.includes("managed"));
    });

    it("kills an unmanaged tmux session", async () => {
      const { mgr } = makeManager();
      tmuxSessions.set("orphan", true);
      const result = await mgr.killTmuxSession("orphan");
      assert.deepStrictEqual(result, { ok: true });
      assert.ok(!tmuxSessions.has("orphan"));
    });

    it("rejects invalid session names", async () => {
      const { mgr } = makeManager();
      const result = await mgr.killTmuxSession("../evil");
      assert.ok(result.error);
    });
  });

  describe("adoptTmuxSession", () => {
    it("adopts an existing tmux session", async () => {
      const { mgr } = makeManager();
      tmuxSessions.set("external", true);
      const result = await mgr.adoptTmuxSession("external");
      assert.strictEqual(result.name, "external");
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });

    it("rejects adopting already-managed session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("mine");
      const result = await mgr.adoptTmuxSession("mine");
      assert.ok(result.error);
    });

    it("rejects invalid names", async () => {
      const { mgr } = makeManager();
      const result = await mgr.adoptTmuxSession("bad name!");
      assert.ok(result.error);
    });
  });

  describe("shutdown", () => {
    it("detaches all sessions without killing tmux", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      await mgr.createSession("b");
      mgr.shutdown();
      // tmux sessions should still exist
      assert.ok(tmuxSessions.has("a"));
      assert.ok(tmuxSessions.has("b"));
    });
  });

  describe("spawn serialization", () => {
    it("concurrent creates for same name both resolve without crash", async () => {
      const { mgr } = makeManager();
      // createSession checks sessions.has() before spawning, so the second
      // call returns "already exists" immediately. The important thing is
      // neither call throws or hangs.
      const [r1, r2] = await Promise.all([
        mgr.createSession("concurrent"),
        mgr.createSession("concurrent"),
      ]);
      const results = [r1, r2];
      const successes = results.filter(r => r.name === "concurrent");
      const errors = results.filter(r => r.error);
      // At least one succeeds, at least one errors — exact split depends on timing
      assert.ok(successes.length >= 1, "At least one should succeed");
      assert.strictEqual(successes.length + errors.length, 2, "Both should resolve");
    });

    it("concurrent attaches to same missing session serialize correctly", async () => {
      const { mgr } = makeManager();
      // attachClient auto-creates missing sessions via spawnSession.
      // Two concurrent attaches to the same non-existent session should
      // both succeed via pendingOps serialization.
      const [r1, r2] = await Promise.all([
        mgr.attachClient("c1", "shared", 80, 24),
        mgr.attachClient("c2", "shared", 80, 24),
      ]);
      assert.strictEqual(r1.alive, true);
      assert.strictEqual(r2.alive, true);
      // Only one session should exist
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });
  });
});
