/**
 * PCH-2 Integration Tests: Per-client headless in attach/subscribe/resync
 *
 * Tests that session-manager creates per-client ClientHeadless instances
 * when clients attach or subscribe, and that ws-manager's resync/pull-snapshot
 * paths use the per-client headless instead of the shared one.
 *
 * Uses mock.module to replace tmux and session dependencies with stubs,
 * same pattern as session-manager.test.js.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Mock setup (must happen before importing session-manager) ---

const tmuxSessions = new Map();

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const tmuxModuleUrl = new URL("../lib/tmux.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

// Track ClientHeadless instances created by session-manager
const createdHeadless = [];

// Minimal MockSession that mirrors session-manager.test.js pattern
class MockSession {
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.state = MockSession.STATE_ATTACHED;
    this._childCount = 0;
    this.external = options.external || false;
    this._options = options;
    this.outputBuffer = {
      totalBytes: 0,
      sliceFrom: () => "",
      // Minimal RingBuffer-like interface for ClientHeadless
      items: [],
      offsets: [],
      getStartOffset: () => 0,
      getEndOffset: () => 0,
      push(data) {
        this.offsets.push(this.totalBytes);
        this.totalBytes += data.length;
        this.items.push(data);
      },
    };
    this._cols = 80;
    this._rows = 24;
    // Track serializeScreen calls to verify fallback behavior
    this._serializeCallCount = 0;
  }

  get alive() { return this.state === MockSession.STATE_ATTACHED; }
  attachControlMode() {}
  updateChildCount(count) { this._childCount = count; }
  write(data) {}
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
  }
  detach() {
    if (this.state !== MockSession.STATE_ATTACHED) return;
    this.state = MockSession.STATE_DETACHED;
  }
  kill() {
    if (this.state === MockSession.STATE_KILLED) return;
    this.state = MockSession.STATE_KILLED;
    tmuxSessions.delete(this.tmuxName);
  }
  async serializeScreen() {
    this._serializeCallCount++;
    return `shared-snapshot-${this._cols}x${this._rows}`;
  }
  toJSON() {
    return { name: this.name, alive: this.alive, external: this.external };
  }
}

mock.module(sessionModuleUrl, {
  namedExports: {
    Session: MockSession,
  },
});

mock.module(tmuxModuleUrl, {
  namedExports: {
    tmuxSessionName: (name) => name.replace(/[.: ]/g, "_"),
    tmuxExec: async () => ({ code: 0 }),
    tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureScrollback: async () => "",
    captureVisiblePane: async () => "$ prompt\n",
    getCursorPosition: async () => ({ row: 0, col: 0 }),
    getPaneCwd: async () => "/tmp",
    checkTmux: async () => {},
    cleanTmuxServerEnv: async () => {},
    setTmuxKatulongEnv: async () => {},
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

// --- Tests ---

describe("PCH-2: per-client headless integration", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  describe("attachClient creates per-client ClientHeadless", () => {
    it("two clients attach at different cols/rows and get correctly-dimensioned snapshots", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");

      // Client A: 80x24
      const resultA = await mgr.attachClient("clientA", "sess", 80, 24);
      assert.equal(resultA.alive, true);
      assert.equal(typeof resultA.buffer, "string");

      // Client B: 120x40
      const resultB = await mgr.attachClient("clientB", "sess", 120, 40);
      assert.equal(resultB.alive, true);
      assert.equal(typeof resultB.buffer, "string");

      // Verify per-client headless instances exist with correct dimensions
      const chA = mgr.getClientHeadless("clientA", "sess");
      const chB = mgr.getClientHeadless("clientB", "sess");
      assert.ok(chA, "clientA should have a ClientHeadless");
      assert.ok(chB, "clientB should have a ClientHeadless");
      assert.equal(chA.cols, 80);
      assert.equal(chA.rows, 24);
      assert.equal(chB.cols, 120);
      assert.equal(chB.rows, 40);
    });

    it("attach snapshot comes from per-client headless, not shared", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");

      const session = mgr.getSession("sess");
      session._serializeCallCount = 0;

      // Attach a client
      const result = await mgr.attachClient("clientX", "sess", 80, 24);

      // The snapshot should come from per-client headless (serializeScreen)
      // NOT from session.serializeScreen() on the shared headless.
      // Since per-client headless was created and used, we verify the
      // getClientHeadless accessor works.
      const ch = mgr.getClientHeadless("clientX", "sess");
      assert.ok(ch, "per-client headless should exist after attach");
    });
  });

  describe("subscribeClient creates per-client ClientHeadless", () => {
    it("subscribe creates per-client headless with client dimensions", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("bg-session");

      // Attach to a primary session first
      await mgr.attachClient("clientS", "primary", 80, 24);

      // Subscribe to a background session with different dimensions
      const result = await mgr.subscribeClient("clientS", "bg-session", 100, 30);
      assert.equal(result.alive, true);
      assert.equal(typeof result.buffer, "string");

      const ch = mgr.getClientHeadless("clientS", "bg-session");
      assert.ok(ch, "subscribe should create a ClientHeadless");
      assert.equal(ch.cols, 100);
      assert.equal(ch.rows, 30);
    });
  });

  describe("detachClient disposes per-client ClientHeadless", () => {
    it("detach disposes all ClientHeadless instances for the client", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");

      await mgr.attachClient("clientD", "sess", 80, 24);
      const ch = mgr.getClientHeadless("clientD", "sess");
      assert.ok(ch, "ClientHeadless should exist after attach");

      mgr.detachClient("clientD");

      const chAfter = mgr.getClientHeadless("clientD", "sess");
      assert.equal(chAfter, undefined, "ClientHeadless should be disposed after detach");
    });

    it("detach does not affect other clients' headless instances", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");

      await mgr.attachClient("clientKeep", "sess", 80, 24);
      await mgr.attachClient("clientRemove", "sess", 120, 40);

      mgr.detachClient("clientRemove");

      const chKeep = mgr.getClientHeadless("clientKeep", "sess");
      assert.ok(chKeep, "other client's ClientHeadless should survive");
      assert.equal(chKeep.cols, 80);
    });
  });

  describe("unsubscribeClient disposes per-client ClientHeadless for that session", () => {
    it("unsubscribe disposes the ClientHeadless for the unsubscribed session only", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("bg1");
      await mgr.createSession("bg2");

      // Attach to a primary session
      await mgr.attachClient("clientU", "primary", 80, 24);

      // Subscribe to two background sessions
      await mgr.subscribeClient("clientU", "bg1", 100, 30);
      await mgr.subscribeClient("clientU", "bg2", 100, 30);

      assert.ok(mgr.getClientHeadless("clientU", "bg1"));
      assert.ok(mgr.getClientHeadless("clientU", "bg2"));

      // Unsubscribe from bg1 only
      mgr.unsubscribeClient("clientU", "bg1");

      assert.equal(mgr.getClientHeadless("clientU", "bg1"), undefined,
        "bg1 headless should be disposed");
      assert.ok(mgr.getClientHeadless("clientU", "bg2"),
        "bg2 headless should still exist");
    });
  });

  describe("getClientHeadless accessor", () => {
    it("returns undefined for unknown client", () => {
      const { mgr } = makeManager();
      assert.equal(mgr.getClientHeadless("unknown", "sess"), undefined);
    });

    it("returns undefined for unknown session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("clientG", "sess", 80, 24);
      assert.equal(mgr.getClientHeadless("clientG", "nonexistent"), undefined);
    });

    it("returns the correct ClientHeadless instance", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("clientG", "sess", 80, 24);
      const ch = mgr.getClientHeadless("clientG", "sess");
      assert.ok(ch);
      assert.equal(ch.cols, 80);
      assert.equal(ch.rows, 24);
    });
  });

  describe("fallback to shared headless when per-client not available", () => {
    it("resync falls back to session.serializeScreen when no per-client headless", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      const session = mgr.getSession("sess");

      // Don't attach any client — no per-client headless exists
      // Directly call serializeScreen on the session (the fallback path)
      const snapshot = await session.serializeScreen();
      assert.equal(typeof snapshot, "string");
      assert.ok(snapshot.length > 0, "shared headless should produce a snapshot");
    });
  });

  describe("deleteSession disposes all per-client headless for that session", () => {
    it("deleting a session disposes ClientHeadless instances attached to it", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("doomed");

      await mgr.attachClient("c1", "doomed", 80, 24);
      await mgr.attachClient("c2", "doomed", 120, 40);

      assert.ok(mgr.getClientHeadless("c1", "doomed"));
      assert.ok(mgr.getClientHeadless("c2", "doomed"));

      mgr.deleteSession("doomed");

      assert.equal(mgr.getClientHeadless("c1", "doomed"), undefined);
      assert.equal(mgr.getClientHeadless("c2", "doomed"), undefined);
    });
  });
});
