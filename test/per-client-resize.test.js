/**
 * Per-Client Resize Tests (PCH-5)
 *
 * Validates that each client's ClientHeadless maintains its own dimensions,
 * active client resize updates both PTY and ClientHeadless, non-active
 * clients retain their dimensions, and client activation resizes the PTY.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Mock tmux and session dependencies ---

const tmuxSessions = new Map();

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const tmuxModuleUrl = new URL("../lib/tmux.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

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
    this._written = [];
    this._resizes = [];
    this._seedCalls = [];
    this._options = options;
    this.icon = null;
    // Use a real-ish outputBuffer so clientHeadlessMap.register works
    this.outputBuffer = { totalBytes: 0, push() {}, sliceFrom() { return ""; }, stats() { return {}; }, clear() {}, toString() { return ""; } };
  }

  get alive() { return this.state === MockSession.STATE_ATTACHED; }
  attachControlMode() {}
  async seedScreen(content, cursorPos) { this._seedCalls.push({ content, cursorPos }); }
  async serializeScreen() { return ""; }
  updateChildCount(count) { this._childCount = count; }
  write(data) { this._written.push(data); }
  resize(cols, rows) { this._resizes.push({ cols, rows }); this._cols = cols; this._rows = rows; }
  detach() {
    if (this.state !== MockSession.STATE_ATTACHED) return;
    this.state = MockSession.STATE_DETACHED;
  }
  kill() {
    if (this.state === MockSession.STATE_KILLED) return;
    this.state = MockSession.STATE_KILLED;
    tmuxSessions.delete(this.tmuxName);
  }
  hasChildProcesses() { return false; }
  toJSON() {
    return { name: this.name, alive: this.alive, external: this.external };
  }
}

mock.module(sessionModuleUrl, {
  namedExports: { Session: MockSession },
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

const { createSessionManager, createClientHeadlessMap } = await import("../lib/session-manager.js");

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

describe("Per-client resize (PCH-5)", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  // ---------------------------------------------------------
  // 1. Active client resize updates both PTY and its ClientHeadless
  // ---------------------------------------------------------
  describe("active client resize updates PTY and ClientHeadless", () => {
    it("resizeClient updates the client's ClientHeadless dimensions", async () => {
      const { mgr } = makeManager();

      // Create session and attach a client
      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);

      // Client A is the only (and therefore active) client — resize it
      mgr.resizeClient("client-A", 120, 40);

      // Verify the session PTY was resized
      const session = mgr.getSession("sess1");
      assert.strictEqual(session._cols, 120);
      assert.strictEqual(session._rows, 40);

      // Verify the ClientHeadless was also resized
      // Use getClientHeadless to check the headless dimensions
      const headless = mgr.getClientHeadless("client-A", "sess1");
      assert.ok(headless, "ClientHeadless should exist for client-A");
      assert.strictEqual(headless.cols, 120, "ClientHeadless cols should be updated");
      assert.strictEqual(headless.rows, 40, "ClientHeadless rows should be updated");
    });

    it("active client resize does not change non-active client's ClientHeadless", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      // Attach two clients
      await mgr.attachClient("client-A", "sess1", 80, 24);
      await mgr.attachClient("client-B", "sess1", 100, 30);

      // client-B is active (most recently attached via markActive in attach)
      // Now resize client-B (the active client)
      mgr.resizeClient("client-B", 120, 40);

      // client-A's headless should retain its original dimensions
      const headlessA = mgr.getClientHeadless("client-A", "sess1");
      assert.ok(headlessA, "ClientHeadless should exist for client-A");
      assert.strictEqual(headlessA.cols, 80, "Non-active client's headless cols should not change");
      assert.strictEqual(headlessA.rows, 24, "Non-active client's headless rows should not change");

      // client-B's headless should be updated
      const headlessB = mgr.getClientHeadless("client-B", "sess1");
      assert.ok(headlessB, "ClientHeadless should exist for client-B");
      assert.strictEqual(headlessB.cols, 120, "Active client's headless cols should be updated");
      assert.strictEqual(headlessB.rows, 40, "Active client's headless rows should be updated");
    });
  });

  // ---------------------------------------------------------
  // 2. Non-active client's ClientHeadless retains own dimensions
  // ---------------------------------------------------------
  describe("non-active client retains own dimensions", () => {
    it("non-active client resize updates only its own ClientHeadless, not PTY", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);
      await mgr.attachClient("client-B", "sess1", 100, 30);

      // client-B is active (most recently attached)
      const session = mgr.getSession("sess1");
      // Record the PTY resize count before non-active resize
      const resizeCountBefore = session._resizes.length;

      // Resize client-A (non-active) — should update its headless but not PTY
      mgr.resizeClient("client-A", 60, 20);

      const headlessA = mgr.getClientHeadless("client-A", "sess1");
      assert.strictEqual(headlessA.cols, 60, "Non-active client's headless should resize");
      assert.strictEqual(headlessA.rows, 20, "Non-active client's headless should resize");

      // PTY should NOT have been resized (non-active client doesn't control PTY)
      // The tracker.resize only resizes PTY for active clients.
      // Find the last resize — it should still be from client-B's attach, not client-A's resize
      const lastResize = session._resizes[session._resizes.length - 1];
      assert.ok(
        lastResize.cols !== 60 || lastResize.rows !== 20,
        "PTY should not be resized to non-active client's dimensions"
      );
    });
  });

  // ---------------------------------------------------------
  // 3. When a client becomes active, PTY resizes to its dimensions
  // ---------------------------------------------------------
  describe("client activation resizes PTY", () => {
    it("when a non-active client sends input and becomes active, PTY resizes to its dimensions", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);
      await mgr.attachClient("client-B", "sess1", 120, 40);

      // client-B is active (most recently attached)
      const session = mgr.getSession("sess1");

      // client-A sends input — markActive is called, making it the new active client
      mgr.writeInput("client-A", "ls\n");

      // PTY should now be resized to client-A's dimensions (80x24)
      const lastResize = session._resizes[session._resizes.length - 1];
      assert.strictEqual(lastResize.cols, 80, "PTY should resize to newly active client's cols");
      assert.strictEqual(lastResize.rows, 24, "PTY should resize to newly active client's rows");
    });
  });

  // ---------------------------------------------------------
  // 4. Two clients at different dimensions: each has its own cols/rows
  // ---------------------------------------------------------
  describe("two clients at different dimensions", () => {
    it("each ClientHeadless reflects its client's dimensions independently", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);
      await mgr.attachClient("client-B", "sess1", 120, 40);

      const headlessA = mgr.getClientHeadless("client-A", "sess1");
      const headlessB = mgr.getClientHeadless("client-B", "sess1");

      assert.ok(headlessA, "ClientHeadless should exist for client-A");
      assert.ok(headlessB, "ClientHeadless should exist for client-B");

      assert.strictEqual(headlessA.cols, 80);
      assert.strictEqual(headlessA.rows, 24);
      assert.strictEqual(headlessB.cols, 120);
      assert.strictEqual(headlessB.rows, 40);

      // They are distinct instances
      assert.notStrictEqual(headlessA, headlessB, "Each client gets a separate headless");
    });

    it("resizing one client does not affect the other's ClientHeadless", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);
      await mgr.attachClient("client-B", "sess1", 100, 30);

      // Resize client-B (active)
      mgr.resizeClient("client-B", 140, 50);

      const headlessA = mgr.getClientHeadless("client-A", "sess1");
      const headlessB = mgr.getClientHeadless("client-B", "sess1");

      assert.strictEqual(headlessA.cols, 80, "client-A headless unchanged");
      assert.strictEqual(headlessA.rows, 24, "client-A headless unchanged");
      assert.strictEqual(headlessB.cols, 140, "client-B headless updated");
      assert.strictEqual(headlessB.rows, 50, "client-B headless updated");
    });
  });

  // ---------------------------------------------------------
  // 5. getClientHeadless helper works correctly
  // ---------------------------------------------------------
  describe("getClientHeadless API", () => {
    it("returns null for unknown client", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      const headless = mgr.getClientHeadless("nonexistent", "sess1");
      assert.strictEqual(headless, null, "Should return null for unknown client");
    });

    it("returns null for unknown session", async () => {
      const { mgr } = makeManager();

      await mgr.createSession("sess1", 80, 24);
      await mgr.attachClient("client-A", "sess1", 80, 24);
      const headless = mgr.getClientHeadless("client-A", "nonexistent");
      assert.strictEqual(headless, null, "Should return null for unknown session");
    });
  });

  // ---------------------------------------------------------
  // 6. clientHeadlessMap.get() unit test
  // ---------------------------------------------------------
  describe("clientHeadlessMap.get()", () => {
    it("returns the ClientHeadless for a known client-session pair", () => {
      const { RingBuffer } = require_ringbuffer();
      const map = createClientHeadlessMap();
      const rb = new MockRingBuffer();

      const headless = map.register("c1", "s1", rb, 80, 24);
      const fetched = map.get("c1", "s1");
      assert.strictEqual(fetched, headless, "get() should return the registered headless");

      map.remove("c1", "s1");
    });

    it("returns null for unknown client-session pair", () => {
      const map = createClientHeadlessMap();
      assert.strictEqual(map.get("unknown", "unknown"), null);
    });
  });
});

// Minimal mock for RingBuffer used in clientHeadlessMap tests
class MockRingBuffer {
  constructor() { this.totalBytes = 0; }
  push() {}
  sliceFrom() { return ""; }
}

function require_ringbuffer() {
  return { RingBuffer: MockRingBuffer };
}
