import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Mock dependencies before importing ws-manager
const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;

mock.module(authModuleUrl, {
  namedExports: {
    loadState: () => null,
  },
});

const { createWebSocketManager } = await import("../lib/ws-manager.js");

function createMockWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    send(data) { sent.push(data); },
    close(code, reason) { this._closed = { code, reason }; this.readyState = 3; },
    terminate() { this._terminated = true; this.readyState = 3; },
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
    subscribers,
  };
}

function createMockSessionManager() {
  // Track client-session bindings (single source of truth, like client-tracker)
  const clientSessions = new Map();
  // Mock sessions with outputBuffer for seq tracking
  const mockSessions = new Map();
  return {
    attachClient: async (clientId, session) => {
      clientSessions.set(clientId, session);
      const s = mockSessions.get(session);
      return { buffer: "", alive: true, seq: s?.outputBuffer?.totalBytes };
    },
    detachClient: (clientId) => { clientSessions.delete(clientId); },
    getSessionForClient: (clientId) => clientSessions.get(clientId) || null,
    isClientSubscribedTo: (clientId, sessionName) => clientSessions.get(clientId) === sessionName,
    getSubscriptionsForClient: () => new Set(),
    getSession: (name) => mockSessions.get(name) || null,
    writeInput: () => {},
    resizeClient: () => {},
    // Test helper: pre-set a client's session binding
    _setSession(clientId, session) { clientSessions.set(clientId, session); },
    _renameSession(oldName, newName) {
      for (const [cid, s] of clientSessions) {
        if (s === oldName) clientSessions.set(cid, newName);
      }
    },
    // Test helper: register a mock session
    _addSession(name, session) { mockSessions.set(name, session); },
  };
}

describe("createWebSocketManager", () => {
  let bridge, sessionManager, wsMgr;

  beforeEach(() => {
    bridge = createMockBridge();
    sessionManager = createMockSessionManager();
    wsMgr = createWebSocketManager({ bridge, sessionManager });
  });

  describe("sendToSession", () => {
    it("routes messages only to clients on the target session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1 });
      wsMgr.wsClients.set("client-2", { ws: ws2 });
      sessionManager._setSession("client-1", "alpha");
      sessionManager._setSession("client-2", "beta");

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 0);
      assert.deepEqual(JSON.parse(ws1.sent[0]), { type: "output", data: "hello" });
    });

    it("skips clients with closed WebSocket", () => {
      const ws = createMockWs(3); // CLOSED
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });
      assert.equal(ws.sent.length, 0);
    });

    it("sends to multiple clients on same session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1 });
      wsMgr.wsClients.set("client-2", { ws: ws2 });
      sessionManager._setSession("client-1", "alpha");
      sessionManager._setSession("client-2", "alpha");

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
    });
  });

  describe("broadcastToAll", () => {
    it("sends to all connected clients regardless of session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1 });
      wsMgr.wsClients.set("client-2", { ws: ws2 });

      wsMgr.broadcastToAll({ type: "credential-registered", tokenId: "tok" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
    });
  });

  describe("closeAllWebSockets", () => {
    it("closes all clients and cleans up", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1 });
      wsMgr.wsClients.set("client-2", { ws: ws2 });

      wsMgr.closeAllWebSockets(1001, "Server shutdown");

      assert.deepEqual(ws1._closed, { code: 1001, reason: "Server shutdown" });
      assert.deepEqual(ws2._closed, { code: 1001, reason: "Server shutdown" });
      assert.equal(wsMgr.wsClients.size, 0);
    });
  });

  describe("bridge subscriber", () => {
    it("routes output to correct session via bridge", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "output", session: "alpha", data: "test output", seq: 0 });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "output", session: "alpha", data: "test output", seq: 0 });
    });

    it("passes seq field through in output messages", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "output", session: "alpha", data: "data", seq: 42 });

      const parsed = JSON.parse(ws.sent[0]);
      assert.equal(parsed.seq, 42);
    });

    it("routes exit events to correct session", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "exit", session: "alpha", code: 0 });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "exit", session: "alpha", code: 0 });
    });

    it("routes session-renamed to clients under the new name", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      // Simulate tracker having already renamed (as session-manager does before relay)
      sessionManager._setSession("client-1", "new-name");

      bridge.relay({ type: "session-renamed", session: "old-name", newName: "new-name" });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "session-renamed", name: "new-name" });
    });

    it("closes all websockets on close-all-websockets bridge event", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });

      bridge.relay({ type: "close-all-websockets", code: 1008, reason: "Auth reset" });

      assert.equal(wsMgr.wsClients.size, 0);
      assert.deepEqual(ws._closed, { code: 1008, reason: "Auth reset" });
    });

    it("closes websockets for specific credential on close-credential-websockets", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1, credentialId: "cred-1" });
      wsMgr.wsClients.set("client-2", { ws: ws2, credentialId: "cred-2" });

      bridge.relay({ type: "close-credential-websockets", credentialId: "cred-1" });

      assert.equal(wsMgr.wsClients.size, 1);
      assert.ok(wsMgr.wsClients.has("client-2"));
      assert.deepEqual(ws1._closed, { code: 1008, reason: "Credential revoked" });
      assert.equal(ws2._closed, null);
    });

    it("input message with session field passes session to writeInput", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      // Find the clientId that was assigned
      const clientId = [...wsMgr.wsClients.keys()][0];

      // Track writeInput calls
      const writeInputCalls = [];
      sessionManager.writeInput = (cid, data, session) => {
        writeInputCalls.push({ clientId: cid, data, session });
      };

      // Simulate attach first (required for auth check to pass with null state)
      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24
      })));

      // Send input with explicit session
      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "input", data: "hello", session: "explicit-session"
      })));

      // Allow message queue to process
      await new Promise(r => setTimeout(r, 10));

      assert.equal(writeInputCalls.length, 1);
      assert.equal(writeInputCalls[0].data, "hello");
      assert.equal(writeInputCalls[0].session, "explicit-session");
    });

    it("input message without session field passes undefined to writeInput", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      const writeInputCalls = [];
      sessionManager.writeInput = (cid, data, session) => {
        writeInputCalls.push({ clientId: cid, data, session });
      };

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24
      })));

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "input", data: "hello"
      })));

      await new Promise(r => setTimeout(r, 10));

      assert.equal(writeInputCalls.length, 1);
      assert.equal(writeInputCalls[0].data, "hello");
      assert.equal(writeInputCalls[0].session, undefined);
    });

    it("resize-sync excludes the active client", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("active-client", { ws: ws1 });
      wsMgr.wsClients.set("passive-client", { ws: ws2 });
      sessionManager._setSession("active-client", "alpha");
      sessionManager._setSession("passive-client", "alpha");

      bridge.relay({ type: "resize-sync", session: "alpha", activeClientId: "active-client", cols: 120, rows: 40 });

      assert.equal(ws1.sent.length, 0, "active client should not receive resize-sync");
      assert.equal(ws2.sent.length, 1);
      assert.deepEqual(JSON.parse(ws2.sent[0]), { type: "resize-sync", cols: 120, rows: 40 });
    });

    it("seq-query responds with seq-status", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);
      const clientId = [...wsMgr.wsClients.keys()][0];

      // Register a mock session with outputBuffer
      sessionManager._addSession("test-session", {
        outputBuffer: { totalBytes: 500 },
      });

      // Attach first
      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      ws.sent.length = 0; // clear attach messages

      // Send seq-query
      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "seq-query",
      })));
      await new Promise(r => setTimeout(r, 10));

      assert.ok(ws.sent.length >= 1);
      const statusMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "seq-status");
      assert.ok(statusMsg, "should receive seq-status");
      assert.equal(statusMsg.session, "test-session");
      assert.equal(statusMsg.seq, 500);
    });

    it("catchup responds with catchup-data when data available", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("test-session", {
        outputBuffer: {
          totalBytes: 100,
          sliceFrom: (offset) => offset >= 100 ? "" : "catchup-data-here",
        },
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "catchup", session: "test-session", fromSeq: 50,
      })));
      await new Promise(r => setTimeout(r, 10));

      const catchupMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "catchup-data");
      assert.ok(catchupMsg, "should receive catchup-data");
      assert.equal(catchupMsg.data, "catchup-data-here");
      assert.equal(catchupMsg.seq, 50);
    });

    it("catchup responds with seq-reset when data evicted", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("test-session", {
        outputBuffer: {
          totalBytes: 100,
          sliceFrom: () => null, // data evicted
        },
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "catchup", session: "test-session", fromSeq: 0,
      })));
      await new Promise(r => setTimeout(r, 10));

      const resetMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "seq-reset");
      assert.ok(resetMsg, "should receive seq-reset");
      assert.equal(resetMsg.session, "test-session");
    });

    it("attach sends seq-init after buffer replay", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("test-session", {
        outputBuffer: { totalBytes: 250 },
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      const seqInitMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "seq-init");
      assert.ok(seqInitMsg, "should receive seq-init");
      assert.equal(seqInitMsg.session, "test-session");
      assert.equal(seqInitMsg.seq, 250);
    });
  });
});
