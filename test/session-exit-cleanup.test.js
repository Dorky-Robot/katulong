/**
 * Session Exit Auto-Cleanup Tests
 *
 * When a shell exits (user types `exit` or the process dies), the tmux
 * control mode process closes and the session's onExit callback fires.
 * The server immediately deletes the session — same behavior as a local
 * terminal closing when the shell exits.
 *
 * Uses mock.module to stub tmux and Session dependencies (same pattern
 * as session-manager.test.js).
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// --- Mocks (same pattern as session-manager.test.js) ---

const tmuxSessions = new Map();

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const tmuxModuleUrl = new URL("../lib/tmux.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

// MockSession that captures onExit so tests can trigger it manually
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
    this.outputBuffer = { totalBytes: 0, sliceFrom: () => "" };
  }

  get alive() { return this.state === MockSession.STATE_ATTACHED; }
  attachControlMode() {}
  async seedScreen() {}
  async serializeScreen() { return ""; }
  updateChildCount(count) { this._childCount = count; }
  write() {}
  resize() {}
  hasChildProcesses() { return false; }
  detach() {
    if (this.state !== MockSession.STATE_ATTACHED) return;
    this.state = MockSession.STATE_DETACHED;
  }
  kill() {
    if (this.state === MockSession.STATE_KILLED) return;
    this.state = MockSession.STATE_KILLED;
    tmuxSessions.delete(this.tmuxName);
  }
  setIcon() {}
  toJSON() {
    return { name: this.name, alive: this.alive, external: this.external };
  }

  /** Test helper: simulate the shell exiting (fires the onExit callback) */
  simulateExit(code = 0) {
    this.state = MockSession.STATE_DETACHED;
    if (this._options.onExit) {
      this._options.onExit(this.name, code);
    }
  }
}

// Store created sessions so tests can call simulateExit on them
const createdSessions = new Map();

class TrackingMockSession extends MockSession {
  constructor(name, tmuxName, options) {
    super(name, tmuxName, options);
    createdSessions.set(name, this);
  }
}

mock.module(sessionModuleUrl, {
  namedExports: { Session: TrackingMockSession },
});

mock.module(tmuxModuleUrl, {
  namedExports: {
    tmuxExec: async () => ({ code: 0 }),
    tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureVisiblePane: async () => "$ prompt\n",
    getCursorPosition: async () => ({ row: 1, col: 10 }),
    checkTmux: async () => {},
    cleanTmuxServerEnv: async () => {},
    setTmuxKatulongEnv: async () => {},
    tmuxListSessions: async () => [...tmuxSessions.keys()],
    tmuxKillSession: async (tmuxName) => { tmuxSessions.delete(tmuxName); },
    tmuxListSessionsDetailed: async () => new Map(),
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

describe("session exit auto-cleanup", () => {
  beforeEach(() => {
    tmuxSessions.clear();
    createdSessions.clear();
  });

  it("immediately deletes a session when the shell exits", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("test1");

    const session = createdSessions.get("test1");
    assert.ok(session, "Session should be created");

    // Simulate shell exit
    session.simulateExit(0);

    // Session should be immediately removed
    const list = mgr.listSessions();
    assert.strictEqual(list.sessions.length, 0, "Session should be deleted immediately");

    // Both exit and session-removed events should be relayed
    const exitMsg = bridge.messages.find(m => m.type === "exit" && m.session === "test1");
    const removedMsg = bridge.messages.find(m => m.type === "session-removed" && m.session === "test1");
    assert.ok(exitMsg, "Exit event should be relayed");
    assert.ok(removedMsg, "session-removed event should be relayed");

    mgr.shutdown();
  });

  it("relays exit event BEFORE session-removed", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("test2");

    createdSessions.get("test2").simulateExit(0);

    const exitIdx = bridge.messages.findIndex(m => m.type === "exit" && m.session === "test2");
    const removedIdx = bridge.messages.findIndex(m => m.type === "session-removed" && m.session === "test2");
    assert.ok(exitIdx >= 0, "Exit event should exist");
    assert.ok(removedIdx >= 0, "session-removed event should exist");
    assert.ok(exitIdx < removedIdx, "Exit event should come before session-removed");

    mgr.shutdown();
  });

  it("is a no-op if session is manually deleted before exit fires", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("test3");

    // Manually delete first
    const result = mgr.deleteSession("test3");
    assert.ok(result.ok, "Manual delete should succeed");

    // Simulate exit on already-deleted session — should not throw
    const session = createdSessions.get("test3");
    session.simulateExit(0);

    assert.strictEqual(mgr.listSessions().sessions.length, 0);
    mgr.shutdown();
  });

  it("handles multiple sessions exiting independently", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("alpha");
    await mgr.createSession("beta");
    await mgr.createSession("gamma");

    // Exit alpha and beta, but not gamma
    createdSessions.get("alpha").simulateExit(0);
    createdSessions.get("beta").simulateExit(1);

    // Only gamma should remain
    const list = mgr.listSessions();
    assert.strictEqual(list.sessions.length, 1, "Only gamma should remain");
    assert.strictEqual(list.sessions[0].name, "gamma");

    // Both alpha and beta should have session-removed events
    assert.ok(bridge.messages.find(m => m.type === "session-removed" && m.session === "alpha"));
    assert.ok(bridge.messages.find(m => m.type === "session-removed" && m.session === "beta"));

    mgr.shutdown();
  });

  it("passes the exit code through in the exit event", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("test5");

    createdSessions.get("test5").simulateExit(42);

    const exitMsg = bridge.messages.find(m => m.type === "exit" && m.session === "test5");
    assert.strictEqual(exitMsg.code, 42, "Exit code should be passed through");

    mgr.shutdown();
  });
});
