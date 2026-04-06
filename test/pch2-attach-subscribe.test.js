/**
 * PCH-2 Integration Tests: Per-client headless in attach/subscribe/resync
 *
 * Tests that session-manager creates per-client ClientHeadless instances
 * when clients attach or subscribe, uses them for serialization instead of
 * the shared headless, and that ws-manager's resync/pull-snapshot paths
 * prefer the per-client headless with shared fallback.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Mock setup (must happen before importing session-manager) ---

const tmuxSessions = new Map();

const sessionModuleUrl = new URL("../lib/session.js", import.meta.url).href;
const tmuxModuleUrl = new URL("../lib/tmux.js", import.meta.url).href;
const envFilterUrl = new URL("../lib/env-filter.js", import.meta.url).href;

// MockSession with RingBuffer-like outputBuffer for ClientHeadless replay
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
    this._serializeResult = "shared-headless-snapshot";
    // RingBuffer-like interface for ClientHeadless
    this.outputBuffer = {
      totalBytes: 0,
      items: [],
      offsets: [],
      push(data) {
        this.offsets.push(this.totalBytes);
        this.totalBytes += data.length;
        this.items.push(data);
      },
      sliceFrom(offset) {
        if (this.offsets.length === 0) {
          return offset === this.totalBytes ? "" : null;
        }
        if (offset < this.offsets[0]) return null;
        if (offset >= this.totalBytes) return "";
        let lo = 0;
        for (let i = 0; i < this.offsets.length; i++) {
          if (this.offsets[i] <= offset) lo = i;
        }
        const skip = offset - this.offsets[lo];
        return this.items.slice(lo).join("").slice(skip);
      },
      getStartOffset() { return this.offsets.length > 0 ? this.offsets[0] : this.totalBytes; },
      getEndOffset() { return this.totalBytes; },
    };
  }

  get alive() { return this.state === MockSession.STATE_ATTACHED; }
  attachControlMode() {}
  async seedScreen() {}
  async serializeScreen() { return this._serializeResult; }
  async screenFingerprint() { return 0; }
  updateChildCount(count) { this._childCount = count; }
  write() {}
  resize() {}
  detach() { if (this.state === MockSession.STATE_ATTACHED) this.state = MockSession.STATE_DETACHED; }
  kill() { if (this.state !== MockSession.STATE_KILLED) { this.state = MockSession.STATE_KILLED; tmuxSessions.delete(this.tmuxName); } }
  setIcon() {}
  toJSON() { return { name: this.name, alive: this.alive, external: this.external }; }
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
    captureVisiblePane: async () => "$ ",
    getCursorPosition: async () => ({ row: 0, col: 2 }),
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

function makeManager() {
  const bridge = makeBridge();
  const mgr = createSessionManager({
    bridge,
    shell: "/bin/sh",
    home: "/tmp",
  });
  return { mgr, bridge };
}

// -------------------------------------------------------------------
// createClientHeadlessMap: get() and disposeAll() methods
// -------------------------------------------------------------------
describe("createClientHeadlessMap extensions (PCH-2)", () => {
  it("get() returns the headless for a specific client-session pair", () => {
    const map = createClientHeadlessMap();
    const rb = { totalBytes: 0, sliceFrom: () => "" };
    const ch = map.register("c1", "sess", rb, 80, 24);
    assert.strictEqual(map.get("c1", "sess"), ch);
    ch.dispose();
  });

  it("get() returns undefined for missing entries", () => {
    const map = createClientHeadlessMap();
    assert.strictEqual(map.get("c1", "nope"), undefined);
  });

  it("disposeAll() disposes and clears all entries", () => {
    const map = createClientHeadlessMap();
    const rb = { totalBytes: 0, sliceFrom: () => "" };
    map.register("c1", "s1", rb, 80, 24);
    map.register("c2", "s2", rb, 80, 24);
    map.disposeAll();
    assert.strictEqual(map.get("c1", "s1"), undefined);
    assert.strictEqual(map.get("c2", "s2"), undefined);
    assert.strictEqual(map.getBySession("s1").length, 0);
  });
});

// -------------------------------------------------------------------
// attachClient: per-client headless serialization
// -------------------------------------------------------------------
describe("attachClient per-client headless (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("serializes from per-client headless instead of shared headless", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");

    // Push data to the outputBuffer so per-client headless has content to replay
    session.outputBuffer.push("$ whoami\r\nroot\r\n$ ");

    const result = await mgr.attachClient("c1", "sess", 80, 24);
    assert.strictEqual(result.alive, true);
    // Buffer should come from per-client headless (ClientHeadless.serializeScreen),
    // NOT from the shared headless. The shared headless mock returns
    // "shared-headless-snapshot", so if the buffer is different, we know
    // the per-client headless was used.
    assert.notStrictEqual(result.buffer, "shared-headless-snapshot",
      "Should use per-client headless, not shared headless");
  });

  it("registers per-client headless accessible via getClientHeadless", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");

    await mgr.attachClient("c1", "sess", 80, 24);
    const ch = mgr.getClientHeadless("c1", "sess");
    assert.ok(ch, "Per-client headless should be registered");
    assert.strictEqual(ch.cols, 80);
    assert.strictEqual(ch.rows, 24);
  });

  it("two clients get independent headless instances at their own dimensions", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session.outputBuffer.push("$ whoami\r\nroot\r\n$ ");

    await mgr.attachClient("c1", "sess", 80, 24);
    await mgr.attachClient("c2", "sess", 120, 40);

    const ch1 = mgr.getClientHeadless("c1", "sess");
    const ch2 = mgr.getClientHeadless("c2", "sess");
    assert.ok(ch1 && ch2, "Both clients should have per-client headless");
    assert.strictEqual(ch1.cols, 80);
    assert.strictEqual(ch1.rows, 24);
    assert.strictEqual(ch2.cols, 120);
    assert.strictEqual(ch2.rows, 40);
  });

  it("re-attach disposes old headless and creates new one", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");

    await mgr.attachClient("c1", "sess", 80, 24);
    const ch1 = mgr.getClientHeadless("c1", "sess");

    // Re-attach with different dimensions
    await mgr.attachClient("c1", "sess", 120, 40);
    const ch2 = mgr.getClientHeadless("c1", "sess");

    assert.notStrictEqual(ch1, ch2, "Should be a new headless instance");
    assert.strictEqual(ch2.cols, 120);
    assert.strictEqual(ch2.rows, 40);
  });

  it("falls back to shared headless when no cols/rows", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._serializeResult = "shared-fallback";

    const result = await mgr.attachClient("c1", "sess");
    // Without cols/rows, should fall back to shared headless
    assert.strictEqual(result.buffer, "shared-fallback");
  });
});

// -------------------------------------------------------------------
// subscribeClient: per-client headless serialization
// -------------------------------------------------------------------
describe("subscribeClient per-client headless (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("serializes from per-client headless on first subscribe", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    const bgSession = mgr.getSession("bg");
    bgSession.outputBuffer.push("background output\r\n");

    // Attach to main, subscribe to bg
    await mgr.attachClient("c1", "main", 80, 24);
    const result = await mgr.subscribeClient("c1", "bg", 80, 24);

    assert.strictEqual(result.alive, true);
    assert.strictEqual(result.isNew, true);
    assert.notStrictEqual(result.buffer, "shared-headless-snapshot",
      "Should use per-client headless for subscribe serialization");
  });

  it("registers per-client headless for subscribed session", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 100, 30);

    const ch = mgr.getClientHeadless("c1", "bg");
    assert.ok(ch, "Should have per-client headless for subscribed session");
    assert.strictEqual(ch.cols, 100);
    assert.strictEqual(ch.rows, 30);
  });

  it("skips serialization on re-subscribe (carousel swipe)", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);
    const result2 = await mgr.subscribeClient("c1", "bg", 80, 24);

    assert.strictEqual(result2.isNew, false);
    assert.strictEqual(result2.buffer, "", "Re-subscribe should return empty buffer");
  });
});

// -------------------------------------------------------------------
// unsubscribeClient: per-client headless cleanup
// -------------------------------------------------------------------
describe("unsubscribeClient cleanup (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("disposes per-client headless on unsubscribe", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);
    assert.ok(mgr.getClientHeadless("c1", "bg"), "Should exist before unsubscribe");

    mgr.unsubscribeClient("c1", "bg");
    assert.strictEqual(mgr.getClientHeadless("c1", "bg"), undefined,
      "Per-client headless should be disposed on unsubscribe");
  });

  it("unsubscribe does not affect headless for other sessions", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg1");
    await mgr.createSession("bg2");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg1", 80, 24);
    await mgr.subscribeClient("c1", "bg2", 80, 24);

    mgr.unsubscribeClient("c1", "bg1");
    assert.strictEqual(mgr.getClientHeadless("c1", "bg1"), undefined);
    assert.ok(mgr.getClientHeadless("c1", "bg2"),
      "Other session's headless should remain");
    assert.ok(mgr.getClientHeadless("c1", "main"),
      "Primary session's headless should remain");
  });
});

// -------------------------------------------------------------------
// detachClient: cleans up all per-client headless
// -------------------------------------------------------------------
describe("detachClient cleanup (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("disposes all per-client headless on detach", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);

    mgr.detachClient("c1");
    assert.strictEqual(mgr.getClientHeadless("c1", "main"), undefined);
    assert.strictEqual(mgr.getClientHeadless("c1", "bg"), undefined);
  });
});

// -------------------------------------------------------------------
// deleteSession: cleans up per-client headless for that session
// -------------------------------------------------------------------
describe("deleteSession cleanup (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("disposes per-client headless for deleted session", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");

    await mgr.attachClient("c1", "sess", 80, 24);
    await mgr.attachClient("c2", "sess", 120, 40);
    assert.ok(mgr.getClientHeadless("c1", "sess"));
    assert.ok(mgr.getClientHeadless("c2", "sess"));

    mgr.deleteSession("sess");
    assert.strictEqual(mgr.getClientHeadless("c1", "sess"), undefined);
    assert.strictEqual(mgr.getClientHeadless("c2", "sess"), undefined);
  });
});

// -------------------------------------------------------------------
// shutdown: disposes all per-client headless
// -------------------------------------------------------------------
describe("shutdown cleanup (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("disposes all per-client headless on shutdown", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("s1");
    await mgr.createSession("s2");

    await mgr.attachClient("c1", "s1", 80, 24);
    await mgr.attachClient("c2", "s2", 120, 40);

    mgr.shutdown();
    assert.strictEqual(mgr.getClientHeadless("c1", "s1"), undefined);
    assert.strictEqual(mgr.getClientHeadless("c2", "s2"), undefined);
  });
});

// -------------------------------------------------------------------
// getClientHeadless: public accessor
// -------------------------------------------------------------------
describe("getClientHeadless accessor (PCH-2)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("returns undefined for unregistered client-session pair", async () => {
    const { mgr } = makeManager();
    assert.strictEqual(mgr.getClientHeadless("c1", "sess"), undefined);
  });

  it("returns the headless instance after attach", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    await mgr.attachClient("c1", "sess", 80, 24);

    const ch = mgr.getClientHeadless("c1", "sess");
    assert.ok(ch);
    // Verify it has the ClientHeadless interface
    assert.strictEqual(typeof ch.serializeScreen, "function");
    assert.strictEqual(typeof ch.screenFingerprint, "function");
    assert.strictEqual(typeof ch.resize, "function");
    assert.strictEqual(typeof ch.dispose, "function");
  });
});
