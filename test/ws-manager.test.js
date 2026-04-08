import { describe, it, beforeEach, afterEach, mock } from "node:test";
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
  // Support multiple handlers per event (transport + handleConnection both attach)
  const handlers = {};
  return {
    readyState,
    bufferedAmount: 0,
    send(data) { sent.push(data); },
    close(code, reason) {
      this._closed = { code, reason }; this.readyState = 3;
      for (const fn of (handlers.close || [])) fn();
    },
    terminate() {
      this._terminated = true; this.readyState = 3;
      for (const fn of (handlers.close || [])) fn();
    },
    ping() {},
    on(event, handler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    off(event, handler) {
      if (handlers[event]) handlers[event] = handlers[event].filter(h => h !== handler);
    },
    // Simulate incoming message (fires all registered message handlers)
    _fireMessage(data) { for (const fn of (handlers.message || [])) fn(data); },
    isAlive: true,
    sent,
    _closed: null,
    _terminated: false,
    _handlers: handlers,
  };
}

/** Minimal transport mock for tests that directly set wsClients entries. */
function mockTransport(ws) {
  return {
    send: (data) => ws.send(data),
    get readyState() { return ws.readyState; },
    get bufferedAmount() { return ws.bufferedAmount; },
    close: (code, reason) => ws.close(code, reason),
    ws,
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

/**
 * Raptor 3 mock session manager. attachClient/subscribeClient return the
 * snapshot shape `{cols, rows, data, alive}` (optionally with `isNew`
 * for subscribe). No pull path, no seq, no outputBuffer.
 */
function createMockSessionManager() {
  // Track client-session bindings (single source of truth, like client-tracker)
  const clientSessions = new Map();
  // Track subscriptions (clientId -> Set<sessionName>)
  const clientSubscriptions = new Map();
  // Mock sessions — plain objects with a `snapshot()` the test can inject.
  const mockSessions = new Map();
  return {
    attachClient: async (clientId, session, cols, rows) => {
      clientSessions.set(clientId, session);
      const s = mockSessions.get(session);
      if (s && typeof s.snapshot === "function") {
        return await s.snapshot();
      }
      return { cols: cols || 80, rows: rows || 24, data: "", alive: true };
    },
    subscribeClient: async (clientId, sessionName) => {
      if (!clientSubscriptions.has(clientId)) clientSubscriptions.set(clientId, new Set());
      const subs = clientSubscriptions.get(clientId);
      const isNew = !subs.has(sessionName);
      subs.add(sessionName);
      const s = mockSessions.get(sessionName);
      if (s && typeof s.snapshot === "function") {
        return { ...(await s.snapshot()), isNew };
      }
      return { cols: 80, rows: 24, data: "", alive: true, isNew };
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
    /**
     * Test helper: register a mock session. Fills in a default
     * Raptor 3 snapshot shape when the caller hasn't supplied one.
     */
    _addSession(name, session) {
      if (!session.snapshot) {
        session.snapshot = async () => ({
          cols: session._cols ?? 80,
          rows: session._rows ?? 24,
          data: session._snapshotData || "",
          alive: session.alive ?? true,
        });
      }
      mockSessions.set(name, session);
    },
  };
}

describe("createWebSocketManager", () => {
  let bridge, sessionManager, wsMgr;

  beforeEach(() => {
    bridge = createMockBridge();
    sessionManager = createMockSessionManager();
    wsMgr = createWebSocketManager({ bridge, sessionManager });
  });

  afterEach(() => {
    // Clear bridge subscribers and close all WS clients to prevent
    // ping interval timers from keeping the event loop alive.
    bridge.removeAllListeners();
    wsMgr.closeAllWebSockets();
  });

  describe("sendToSession", () => {
    it("routes messages only to clients on the target session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws1) });
      wsMgr.wsClients.set("client-2", { transport: mockTransport(ws2) });
      sessionManager._setSession("client-1", "alpha");
      sessionManager._setSession("client-2", "beta");

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 0);
      assert.deepEqual(JSON.parse(ws1.sent[0]), { type: "output", data: "hello" });
    });

    it("skips clients with closed WebSocket", () => {
      const ws = createMockWs(3); // CLOSED
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });
      sessionManager._setSession("client-1", "alpha");

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });
      assert.equal(ws.sent.length, 0);
    });

    it("sends to multiple clients on same session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws1) });
      wsMgr.wsClients.set("client-2", { transport: mockTransport(ws2) });
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

      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws1) });
      wsMgr.wsClients.set("client-2", { transport: mockTransport(ws2) });

      wsMgr.broadcastToAll({ type: "credential-registered", tokenId: "tok" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
    });
  });

  describe("closeAllWebSockets", () => {
    it("closes all clients and cleans up", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws1) });
      wsMgr.wsClients.set("client-2", { transport: mockTransport(ws2) });

      wsMgr.closeAllWebSockets(1001, "Server shutdown");

      assert.deepEqual(ws1._closed, { code: 1001, reason: "Server shutdown" });
      assert.deepEqual(ws2._closed, { code: 1001, reason: "Server shutdown" });
      assert.equal(wsMgr.wsClients.size, 0);
    });
  });

  describe("bridge subscriber", () => {
    it("pushes output inline to subscribed clients", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "output", session: "alpha", data: "hello" });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "output", session: "alpha", data: "hello",
      });
    });

    it("relays snapshot messages to subscribed clients", () => {
      // Raptor 3: the bridge case for `snapshot` ships the full
      // {cols, rows, data} envelope so clients can atomically reset
      // their xterm to the new server-authoritative state.
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({
        type: "snapshot",
        session: "alpha",
        cols: 120,
        rows: 40,
        data: "fresh-screen",
      });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), {
        type: "snapshot",
        session: "alpha",
        cols: 120,
        rows: 40,
        data: "fresh-screen",
      });
    });

    it("routes exit events to correct session", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });
      sessionManager._setSession("client-1", "alpha");

      bridge.relay({ type: "exit", session: "alpha", code: 0 });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "exit", session: "alpha", code: 0 });
    });

    it("routes session-renamed to clients under the new name", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });
      // Simulate tracker having already renamed (as session-manager does before relay)
      sessionManager._setSession("client-1", "new-name");

      bridge.relay({ type: "session-renamed", session: "old-name", newName: "new-name" });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "session-renamed", name: "new-name" });
    });

    it("closes all websockets on close-all-websockets bridge event", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws) });

      bridge.relay({ type: "close-all-websockets", code: 1008, reason: "Auth reset" });

      assert.equal(wsMgr.wsClients.size, 0);
      assert.deepEqual(ws._closed, { code: 1008, reason: "Auth reset" });
    });

    it("closes websockets for specific credential on close-credential-websockets", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { transport: mockTransport(ws1), credentialId: "cred-1" });
      wsMgr.wsClients.set("client-2", { transport: mockTransport(ws2), credentialId: "cred-2" });

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
      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24
      })));

      // Send input with explicit session
      await ws._fireMessage(Buffer.from(JSON.stringify({
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

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24
      })));

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "input", data: "hello"
      })));

      await new Promise(r => setTimeout(r, 10));

      assert.equal(writeInputCalls.length, 1);
      assert.equal(writeInputCalls[0].data, "hello");
      assert.equal(writeInputCalls[0].session, undefined);
    });

    it("attach responds with attached carrying the snapshot envelope", async () => {
      // Raptor 3: the `attached` message is the only way the client
      // learns authoritative dims + initial screen content. The client
      // applies term.resize → clear → write atomically.
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("test-session", {
        _cols: 100,
        _rows: 30,
        _snapshotData: "hello world",
        alive: true,
      });

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "test-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));

      const attachedMsg = ws.sent.map(s => JSON.parse(s)).find(m => m.type === "attached");
      assert.ok(attachedMsg, "should receive attached");
      assert.equal(attachedMsg.session, "test-session");
      assert.equal(attachedMsg.cols, 100);
      assert.equal(attachedMsg.rows, 30);
      assert.equal(attachedMsg.data, "hello world");
    });

    it("subscribe sends subscribed with the session snapshot envelope", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("bg-session", {
        _cols: 90,
        _rows: 24,
        _snapshotData: "$ hello world\r\nprompt> ",
        alive: true,
      });

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "bg-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "subscribe", session: "bg-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const subscribedMsg = msgs.find(m => m.type === "subscribed");
      assert.ok(subscribedMsg, "should receive subscribed");
      assert.equal(subscribedMsg.session, "bg-session");
      assert.equal(subscribedMsg.cols, 90);
      assert.equal(subscribedMsg.rows, 24);
      assert.equal(subscribedMsg.data, "$ hello world\r\nprompt> ");
    });

    it("subscribe with empty session still sends a subscribed envelope", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("empty-session", {
        _cols: 80,
        _rows: 24,
        _snapshotData: "",
        alive: true,
      });

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "empty-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "subscribe", session: "empty-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const subscribedMsg = msgs.find(m => m.type === "subscribed");
      assert.ok(subscribedMsg, "should receive subscribed");
      assert.equal(subscribedMsg.data, "");
    });

    it("subscribe sends exit for dead session", async () => {
      const ws = createMockWs();
      wsMgr.handleConnection(ws);

      sessionManager._addSession("dead-session", {
        _cols: 80,
        _rows: 24,
        _snapshotData: "final output",
        alive: false,
      });

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "attach", session: "dead-session", cols: 80, rows: 24,
      })));
      await new Promise(r => setTimeout(r, 10));
      ws.sent.length = 0;

      await ws._fireMessage(Buffer.from(JSON.stringify({
        type: "subscribe", session: "dead-session",
      })));
      await new Promise(r => setTimeout(r, 10));

      const msgs = ws.sent.map(s => JSON.parse(s));
      const exitMsg = msgs.find(m => m.type === "exit");
      assert.ok(exitMsg, "should send exit for dead session");
    });
  });
});
