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
  // Track subscriptions (clientId -> Set<sessionName>)
  const clientSubscriptions = new Map();
  // Mock sessions with outputBuffer for seq tracking
  const mockSessions = new Map();
  return {
    attachClient: async (clientId, session) => {
      clientSessions.set(clientId, session);
      const s = mockSessions.get(session);
      return { buffer: "", alive: true, seq: s?.outputBuffer?.totalBytes };
    },
    subscribeClient: async (clientId, sessionName) => {
      if (!clientSubscriptions.has(clientId)) clientSubscriptions.set(clientId, new Set());
      clientSubscriptions.get(clientId).add(sessionName);
      const s = mockSessions.get(sessionName);
      return {
        buffer: s?._subscribeBuffer || "",
        seq: s?.outputBuffer?.totalBytes,
        alive: s?.alive ?? true,
      };
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
    it("routes data-available notification to correct session via bridge", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "data-available", session: "alpha" });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "data-available", session: "alpha" });
    });

    it("routes resync snapshot to correct session", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "resync", session: "alpha", data: "snapshot-data", seq: 42 });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "resync", session: "alpha", data: "snapshot-data", seq: 42,
      });
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

    it("pull responds with pull-response when data available", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("test-session", {
        tmuxName: "katulong_test-session",
        outputBuffer: {
          totalBytes: 100,
          sliceFrom: (offset) => offset >= 100 ? "" : "pulled-data-here",
        },
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "pull", session: "test-session", fromSeq: 50,
      })));
      await new Promise(r => setTimeout(r, 10));

      const pullMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "pull-response");
      assert.ok(pullMsg, "should receive pull-response");
      assert.equal(pullMsg.data, "pulled-data-here");
      assert.equal(pullMsg.cursor, 100);
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

    it("subscribe sends buffer snapshot bundled in subscribed message", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("bg-session", {
        _subscribeBuffer: "$ hello world\r\nprompt> ",
        outputBuffer: { totalBytes: 500 },
        alive: true,
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "bg-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "subscribe", session: "bg-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const subscribedMsg = msgs.find(m => m.type === "subscribed");
      assert.ok(subscribedMsg, "should receive subscribed");
      assert.equal(subscribedMsg.session, "bg-session");
      assert.equal(subscribedMsg.data, "$ hello world\r\nprompt> ");

      const seqMsg = msgs.find(m => m.type === "seq-init");
      assert.ok(seqMsg, "should receive seq-init");
      assert.equal(seqMsg.seq, 500);
    });

    it("subscribe with empty buffer sends no output message", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("empty-session", {
        _subscribeBuffer: "",
        outputBuffer: { totalBytes: 0 },
        alive: true,
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "empty-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "subscribe", session: "empty-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const subscribedMsg = msgs.find(m => m.type === "subscribed");
      assert.ok(subscribedMsg, "should receive subscribed");
      assert.equal(subscribedMsg.data, "", "empty buffer should send empty string");
    });

    it("subscribe sends exit for dead session", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("dead-session", {
        _subscribeBuffer: "final output",
        outputBuffer: { totalBytes: 100 },
        alive: false,
      });

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "attach", session: "dead-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._handlers.message(Buffer.from(JSON.stringify({
        type: "subscribe", session: "dead-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const exitMsg = msgs.find(m => m.type === "exit");
      assert.ok(exitMsg, "should send exit for dead session");
    });
  });
});
