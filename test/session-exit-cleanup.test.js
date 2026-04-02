/**
 * Session Exit Auto-Cleanup Tests
 *
 * When a shell exits (user types `exit` or the process dies), the tmux
 * control mode process closes and the session's onExit callback fires.
 * The server should automatically delete the dead session after a short
 * delay so clients see the "[shell exited]" message before the session
 * disappears from the list.
 *
 * Uses mock.module to stub tmux and Session dependencies (same pattern
 * as session-manager.test.js).
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
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
    this._cols = 0;
    this._rows = 0;
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
const OrigMockSession = MockSession;

// Proxy constructor to capture instances
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
    tmuxSessionName: (name) => name.replace(/[.: ]/g, "_"),
    tmuxExec: async () => ({ code: 0 }),
    tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
    tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
    applyTmuxSessionOptions: async () => {},
    captureScrollback: async () => "",
    captureVisiblePane: async () => "$ prompt\n",
    getCursorPosition: async () => ({ row: 1, col: 10 }),
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

/** Wait for a specified number of milliseconds */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("session exit auto-cleanup", () => {
  beforeEach(() => {
    tmuxSessions.clear();
    createdSessions.clear();
  });

  it("auto-deletes a session after the shell exits", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("test1");

    const session = createdSessions.get("test1");
    assert.ok(session, "Session should be created");

    // Simulate shell exit
    session.simulateExit(0);

    // The exit event should be relayed immediately
    const exitMsg = bridge.messages.find(m => m.type === "exit" && m.session === "test1");
    assert.ok(exitMsg, "Exit event should be relayed to clients");

    // Session should still exist right after exit (delay not yet elapsed)
    const listBefore = mgr.listSessions();
    assert.strictEqual(listBefore.sessions.length, 1, "Session should still exist during grace period");

    // Wait for the auto-cleanup delay (2s + buffer)
    await delay(2500);

    // Now the session should be removed
    const listAfter = mgr.listSessions();
    assert.strictEqual(listAfter.sessions.length, 0, "Session should be auto-deleted after delay");

    // A session-removed event should have been relayed
    const removedMsg = bridge.messages.find(m => m.type === "session-removed" && m.session === "test1");
    assert.ok(removedMsg, "session-removed event should be relayed");

    mgr.shutdown();
  });

  it("relays exit event BEFORE deleting the session", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("test2");

    const session = createdSessions.get("test2");
    session.simulateExit(0);

    // Find the indices of exit and session-removed messages
    const exitIdx = bridge.messages.findIndex(m => m.type === "exit" && m.session === "test2");
    assert.ok(exitIdx >= 0, "Exit event should exist");

    // session-removed should NOT exist yet (cleanup is delayed)
    const removedIdx = bridge.messages.findIndex(m => m.type === "session-removed" && m.session === "test2");
    assert.strictEqual(removedIdx, -1, "session-removed should not fire immediately");

    // Wait for cleanup
    await delay(2500);

    // Now both should exist, with exit before session-removed
    const exitIdx2 = bridge.messages.findIndex(m => m.type === "exit" && m.session === "test2");
    const removedIdx2 = bridge.messages.findIndex(m => m.type === "session-removed" && m.session === "test2");
    assert.ok(exitIdx2 < removedIdx2, "Exit event should come before session-removed");

    mgr.shutdown();
  });

  it("is a no-op if session is manually deleted before auto-cleanup fires", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("test3");

    const session = createdSessions.get("test3");
    session.simulateExit(0);

    // Manually delete before the timer fires
    const result = mgr.deleteSession("test3");
    assert.ok(result.ok, "Manual delete should succeed");

    // Wait for the auto-cleanup timer — should not throw or error
    await delay(2500);

    // Session list should be empty (already deleted)
    const list = mgr.listSessions();
    assert.strictEqual(list.sessions.length, 0, "Session list should be empty");

    mgr.shutdown();
  });

  it("cancels cleanup timers on shutdown (no dangling timers)", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("test4");

    const session = createdSessions.get("test4");
    session.simulateExit(0);

    // Shutdown immediately — should cancel the auto-cleanup timer
    mgr.shutdown();

    // Wait past the cleanup delay — session should NOT be deleted
    // (shutdown already detached all sessions, but the point is no errors)
    await delay(2500);

    // No error thrown — test passes
  });

  it("handles multiple sessions exiting independently", async () => {
    const { mgr, bridge } = makeManager();
    await mgr.createSession("alpha");
    await mgr.createSession("beta");
    await mgr.createSession("gamma");

    const alpha = createdSessions.get("alpha");
    const beta = createdSessions.get("beta");

    // Exit alpha and beta, but not gamma
    alpha.simulateExit(0);
    beta.simulateExit(1);

    // gamma should still be alive
    const gammaSession = mgr.getSession("gamma");
    assert.ok(gammaSession.alive, "gamma should still be alive");

    // Wait for auto-cleanup
    await delay(2500);

    // Only gamma should remain
    const list = mgr.listSessions();
    assert.strictEqual(list.sessions.length, 1, "Only gamma should remain");
    assert.strictEqual(list.sessions[0].name, "gamma", "Remaining session should be gamma");

    // Both alpha and beta should have session-removed events
    const alphaRemoved = bridge.messages.find(m => m.type === "session-removed" && m.session === "alpha");
    const betaRemoved = bridge.messages.find(m => m.type === "session-removed" && m.session === "beta");
    assert.ok(alphaRemoved, "alpha should have session-removed event");
    assert.ok(betaRemoved, "beta should have session-removed event");

    mgr.shutdown();
  });
});
