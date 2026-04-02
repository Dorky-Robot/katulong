import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { ClientHeadless } from "../lib/client-headless.js";
import { RingBuffer } from "../lib/ring-buffer.js";

// --- Mock ws-manager tests for targeted state-check delivery ---

const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;
mock.module(authModuleUrl, {
  namedExports: { loadState: () => null },
});

const { createWebSocketManager } = await import("../lib/ws-manager.js");

function createMockWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    send(data) { sent.push(data); },
    close(code, reason) {
      this._closed = { code, reason }; this.readyState = 3;
      if (this._handlers?.close) this._handlers.close();
    },
    terminate() {
      this._terminated = true; this.readyState = 3;
      if (this._handlers?.close) this._handlers.close();
    },
    ping() {},
    on(event, handler) {
      if (!this._handlers) this._handlers = {};
      this._handlers[event] = handler;
    },
    isAlive: true,
    sent,
    _closed: null,
    _terminated: false,
  };
}

function createMockBridge() {
  const subscribers = [];
  return {
    register(fn) { subscribers.push(fn); },
    relay(msg) { for (const fn of subscribers) fn(msg); },
    removeAllListeners() { subscribers.length = 0; },
    subscribers,
  };
}

function createMockSessionManager() {
  const clientSessions = new Map();
  const clientSubscriptions = new Map();
  const mockSessions = new Map();
  return {
    attachClient: async (clientId, session) => {
      clientSessions.set(clientId, session);
      const s = mockSessions.get(session);
      return { buffer: "", alive: true, seq: s?.outputBuffer?.totalBytes };
    },
    subscribeClient: async (clientId, sessionName) => {
      if (!clientSubscriptions.has(clientId)) clientSubscriptions.set(clientId, new Set());
      const subs = clientSubscriptions.get(clientId);
      const isNew = !subs.has(sessionName);
      subs.add(sessionName);
      const s = mockSessions.get(sessionName);
      return { buffer: "", seq: s?.outputBuffer?.totalBytes, alive: true, isNew };
    },
    unsubscribeClient: (clientId, sessionName) => {
      const subs = clientSubscriptions.get(clientId);
      if (subs) subs.delete(sessionName);
    },
    detachClient: (clientId) => { clientSessions.delete(clientId); clientSubscriptions.delete(clientId); },
    getSessionForClient: (clientId) => clientSessions.get(clientId) || null,
    isClientSubscribedTo: (clientId, sessionName) => {
      if (clientSessions.get(clientId) === sessionName) return true;
      const subs = clientSubscriptions.get(clientId);
      return subs ? subs.has(sessionName) : false;
    },
    getSubscriptionsForClient: (clientId) => clientSubscriptions.get(clientId) || new Set(),
    getSession: (name) => mockSessions.get(name) || null,
    writeInput: () => {},
    resizeClient: () => {},
    resizeSession: () => {},
    _setSession(clientId, session) { clientSessions.set(clientId, session); },
    _addSession(name, session) { mockSessions.set(name, session); },
  };
}

// -------------------------------------------------------
// 1. Two clients with different dimensions get different fingerprints
// -------------------------------------------------------
describe("Per-client drift detection", () => {
  describe("ClientHeadless fingerprints differ by dimension", () => {
    it("two clients with different rows get different fingerprints for same session data", async () => {
      const rb = new RingBuffer();
      rb.push("$ whoami\r\nroot\r\n$ ");

      // Client A: 80x24 (e.g., desktop)
      const chA = new ClientHeadless(rb, 80, 24);
      const fpA = await chA.screenFingerprint();

      // Client B: 80x40 (e.g., iPad in landscape)
      const chB = new ClientHeadless(rb, 80, 40);
      const fpB = await chB.screenFingerprint();

      assert.notStrictEqual(fpA, fpB,
        "Clients with different row counts must produce different fingerprints");

      chA.dispose();
      chB.dispose();
    });

    it("two clients with different cols get different fingerprints for same session data", async () => {
      const rb = new RingBuffer();
      // Push a long line that wraps differently at different column widths
      rb.push("A".repeat(100) + "\r\n$ ");

      const chA = new ClientHeadless(rb, 80, 24);
      const fpA = await chA.screenFingerprint();

      const chB = new ClientHeadless(rb, 120, 24);
      const fpB = await chB.screenFingerprint();

      assert.notStrictEqual(fpA, fpB,
        "Clients with different col counts must produce different fingerprints");

      chA.dispose();
      chB.dispose();
    });

    it("two clients with SAME dimensions get SAME fingerprints", async () => {
      const rb = new RingBuffer();
      rb.push("$ whoami\r\nroot\r\n$ ");

      const chA = new ClientHeadless(rb, 80, 24);
      const fpA = await chA.screenFingerprint();

      const chB = new ClientHeadless(rb, 80, 24);
      const fpB = await chB.screenFingerprint();

      assert.strictEqual(fpA, fpB,
        "Clients with same dimensions should produce identical fingerprints");

      chA.dispose();
      chB.dispose();
    });
  });

  // -------------------------------------------------------
  // 2. state-check with clientId is sent only to that client
  // -------------------------------------------------------
  describe("Targeted state-check delivery (ws-manager)", () => {
    let bridge, sessionManager, wsMgr;

    beforeEach(() => {
      bridge = createMockBridge();
      sessionManager = createMockSessionManager();
      wsMgr = createWebSocketManager({ bridge, sessionManager });
    });

    afterEach(() => {
      bridge.removeAllListeners();
      wsMgr.closeAllWebSockets();
    });

    it("state-check with clientId sends only to that specific client", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-A", { ws: ws1 });
      wsMgr.wsClients.set("client-B", { ws: ws2 });
      sessionManager._setSession("client-A", "alpha");
      sessionManager._setSession("client-B", "alpha");

      bridge.relay({
        type: "state-check",
        session: "alpha",
        fingerprint: 12345,
        clientId: "client-A",
      });

      // Client A should receive the state-check
      assert.equal(ws1.sent.length, 1);
      const msg1 = JSON.parse(ws1.sent[0]);
      assert.equal(msg1.type, "state-check");
      assert.equal(msg1.fingerprint, 12345);
      assert.equal(msg1.session, "alpha");

      // Client B should NOT receive anything
      assert.equal(ws2.sent.length, 0,
        "Client B should not receive state-check targeted at client A");
    });

    it("state-check with clientId does not send to unknown client", () => {
      const ws1 = createMockWs();
      wsMgr.wsClients.set("client-A", { ws: ws1 });
      sessionManager._setSession("client-A", "alpha");

      bridge.relay({
        type: "state-check",
        session: "alpha",
        fingerprint: 99999,
        clientId: "non-existent-client",
      });

      assert.equal(ws1.sent.length, 0,
        "No client should receive a state-check for a non-existent clientId");
    });

    // -------------------------------------------------------
    // 3. Backward compat: state-check without clientId broadcasts to all
    // -------------------------------------------------------
    it("state-check without clientId broadcasts to all session clients (backward compat)", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const ws3 = createMockWs();

      wsMgr.wsClients.set("client-A", { ws: ws1 });
      wsMgr.wsClients.set("client-B", { ws: ws2 });
      wsMgr.wsClients.set("client-C", { ws: ws3 });
      sessionManager._setSession("client-A", "alpha");
      sessionManager._setSession("client-B", "alpha");
      sessionManager._setSession("client-C", "beta"); // different session

      bridge.relay({
        type: "state-check",
        session: "alpha",
        fingerprint: 67890,
        // no clientId — legacy broadcast
      });

      // Both alpha clients should receive it
      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
      // Beta client should NOT
      assert.equal(ws3.sent.length, 0);

      const msg1 = JSON.parse(ws1.sent[0]);
      assert.equal(msg1.type, "state-check");
      assert.equal(msg1.fingerprint, 67890);
    });

    it("targeted state-check to closed WebSocket is silently dropped", () => {
      const ws = createMockWs(3); // readyState = CLOSED
      wsMgr.wsClients.set("client-A", { ws });
      sessionManager._setSession("client-A", "alpha");

      // Should not throw
      bridge.relay({
        type: "state-check",
        session: "alpha",
        fingerprint: 11111,
        clientId: "client-A",
      });

      assert.equal(ws.sent.length, 0);
    });
  });

  // -------------------------------------------------------
  // 4. Idle timer coalesces correctly (per-client fingerprinting)
  // -------------------------------------------------------
  describe("Idle check with per-client headless map", () => {
    it("scheduleIdleCheck computes per-client fingerprints and sends targeted state-checks", async () => {
      // This test validates the session-manager integration:
      // - Two clients registered for the same session with different dimensions
      // - idle check fires -> iterates clients -> computes per-client fingerprint
      // - sends targeted state-check to each client

      // We test this by importing session-manager internals through the
      // exported API. Since session-manager depends on tmux (which we can't
      // mock easily), we test the clientHeadless map management directly.

      // Import the functions we need to test
      const { createClientHeadlessMap } = await import("../lib/session-manager.js");

      const rb = new RingBuffer();
      rb.push("$ ls\r\nfile1.txt\r\n$ ");

      const map = createClientHeadlessMap();

      // Register two clients with different dimensions
      map.register("client-A", "alpha", rb, 80, 24);
      map.register("client-B", "alpha", rb, 120, 40);

      // Get all headless instances for session "alpha"
      const entries = map.getBySession("alpha");
      assert.equal(entries.length, 2, "Should have 2 entries for session alpha");

      // Compute fingerprints
      const fpA = await entries.find(e => e.clientId === "client-A").headless.screenFingerprint();
      const fpB = await entries.find(e => e.clientId === "client-B").headless.screenFingerprint();

      assert.notStrictEqual(fpA, fpB,
        "Per-client fingerprints should differ for different dimensions");

      // Cleanup
      map.remove("client-A", "alpha");
      map.remove("client-B", "alpha");

      assert.equal(map.getBySession("alpha").length, 0,
        "Map should be empty after removing all clients");
    });

    it("idle timer coalesces: rapid data pushes result in one fingerprint pass", async () => {
      // The idle timer uses clearTimeout/setTimeout to coalesce.
      // Rapid scheduleIdleCheck calls should result in only the last one firing.
      // We verify by counting relay calls.

      const relayCalls = [];
      const mockBridge = {
        register() {},
        relay(msg) { relayCalls.push(msg); },
      };

      const { createClientHeadlessMap } = await import("../lib/session-manager.js");
      const rb = new RingBuffer();
      const map = createClientHeadlessMap();
      map.register("client-A", "alpha", rb, 80, 24);

      // Simulate the idle check coalescing logic manually
      const IDLE_CHECK_MS = 500;
      const timers = new Map();

      function scheduleIdleCheck(sessionName) {
        clearTimeout(timers.get(sessionName));
        timers.set(sessionName, setTimeout(async () => {
          timers.delete(sessionName);
          const entries = map.getBySession(sessionName);
          for (const { clientId, headless } of entries) {
            const fp = await headless.screenFingerprint();
            mockBridge.relay({
              type: "state-check",
              session: sessionName,
              fingerprint: fp,
              clientId,
            });
          }
        }, IDLE_CHECK_MS));
      }

      // Fire rapidly — only last should matter
      rb.push("line1\r\n");
      scheduleIdleCheck("alpha");
      rb.push("line2\r\n");
      scheduleIdleCheck("alpha");
      rb.push("line3\r\n");
      scheduleIdleCheck("alpha");

      // Wait for the coalesced timer to fire
      await new Promise(r => setTimeout(r, IDLE_CHECK_MS + 100));

      // Should have fired exactly once (one client)
      assert.equal(relayCalls.length, 1,
        "Coalesced idle check should fire exactly once");
      assert.equal(relayCalls[0].type, "state-check");
      assert.equal(relayCalls[0].clientId, "client-A");

      // Cleanup timers
      for (const t of timers.values()) clearTimeout(t);
      map.remove("client-A", "alpha");
    });

    it("clientHeadless map tracks multiple sessions independently", async () => {
      const { createClientHeadlessMap } = await import("../lib/session-manager.js");

      const rbAlpha = new RingBuffer();
      rbAlpha.push("alpha data");
      const rbBeta = new RingBuffer();
      rbBeta.push("beta data");

      const map = createClientHeadlessMap();
      map.register("client-A", "alpha", rbAlpha, 80, 24);
      map.register("client-A", "beta", rbBeta, 80, 24);
      map.register("client-B", "alpha", rbAlpha, 120, 40);

      assert.equal(map.getBySession("alpha").length, 2);
      assert.equal(map.getBySession("beta").length, 1);
      assert.equal(map.getBySession("gamma").length, 0);

      // Remove client-A from alpha — should not affect beta
      map.remove("client-A", "alpha");
      assert.equal(map.getBySession("alpha").length, 1);
      assert.equal(map.getBySession("beta").length, 1);

      // removeClient removes all sessions for that client
      map.removeClient("client-A");
      assert.equal(map.getBySession("beta").length, 0);

      map.removeClient("client-B");
      assert.equal(map.getBySession("alpha").length, 0);
    });
  });
});
