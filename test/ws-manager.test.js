import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Mock dependencies before importing ws-manager
const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;
const p2pModuleUrl = new URL("../lib/p2p.js", import.meta.url).href;
const lanModuleUrl = new URL("../lib/lan.js", import.meta.url).href;

mock.module(authModuleUrl, {
  namedExports: {
    loadState: () => null,
  },
});

mock.module(p2pModuleUrl, {
  namedExports: {
    createServerPeer: () => ({}),
    destroyPeer: () => {},
    p2pAvailable: false,
  },
});

mock.module(lanModuleUrl, {
  namedExports: {
    getLanAddresses: () => [],
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
  return {
    attachClient: async () => ({ buffer: "", alive: true }),
    detachClient: () => {},
    writeInput: () => {},
    resizeClient: () => {},
    _detached: [],
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

      wsMgr.wsClients.set("client-1", { ws: ws1, session: "alpha", p2pPeer: null, p2pConnected: false });
      wsMgr.wsClients.set("client-2", { ws: ws2, session: "beta", p2pPeer: null, p2pConnected: false });

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 0);
      assert.deepEqual(JSON.parse(ws1.sent[0]), { type: "output", data: "hello" });
    });

    it("skips clients with closed WebSocket", () => {
      const ws = createMockWs(3); // CLOSED
      wsMgr.wsClients.set("client-1", { ws, session: "alpha", p2pPeer: null, p2pConnected: false });

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });
      assert.equal(ws.sent.length, 0);
    });

    it("sends to multiple clients on same session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1, session: "alpha", p2pPeer: null, p2pConnected: false });
      wsMgr.wsClients.set("client-2", { ws: ws2, session: "alpha", p2pPeer: null, p2pConnected: false });

      wsMgr.sendToSession("alpha", { type: "output", data: "hello" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
    });
  });

  describe("broadcastToAll", () => {
    it("sends to all connected clients regardless of session", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1, session: "alpha" });
      wsMgr.wsClients.set("client-2", { ws: ws2, session: "beta" });

      wsMgr.broadcastToAll({ type: "credential-registered", tokenId: "tok" });

      assert.equal(ws1.sent.length, 1);
      assert.equal(ws2.sent.length, 1);
    });
  });

  describe("closeAllWebSockets", () => {
    it("closes all clients and cleans up", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1, session: "alpha", p2pPeer: null });
      wsMgr.wsClients.set("client-2", { ws: ws2, session: "beta", p2pPeer: null });

      wsMgr.closeAllWebSockets(1001, "Server shutdown");

      assert.deepEqual(ws1._closed, { code: 1001, reason: "Server shutdown" });
      assert.deepEqual(ws2._closed, { code: 1001, reason: "Server shutdown" });
      assert.equal(wsMgr.wsClients.size, 0);
    });
  });

  describe("bridge subscriber", () => {
    it("routes output to correct session via bridge", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws, session: "alpha", p2pPeer: null, p2pConnected: false });

      bridge.relay({ type: "output", session: "alpha", data: "test output" });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "output", data: "test output" });
    });

    it("routes exit events to correct session", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws, session: "alpha", p2pPeer: null, p2pConnected: false });

      bridge.relay({ type: "exit", session: "alpha", code: 0 });

      assert.equal(ws.sent.length, 1);
      assert.deepEqual(JSON.parse(ws.sent[0]), { type: "exit", code: 0 });
    });

    it("updates client session name on session-renamed", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws, session: "old-name", p2pPeer: null, p2pConnected: false });

      bridge.relay({ type: "session-renamed", session: "old-name", newName: "new-name" });

      const info = wsMgr.wsClients.get("client-1");
      assert.equal(info.session, "new-name");
    });

    it("closes all websockets on close-all-websockets bridge event", () => {
      const ws = createMockWs();
      wsMgr.wsClients.set("client-1", { ws, session: "alpha", p2pPeer: null });

      bridge.relay({ type: "close-all-websockets", code: 1008, reason: "Auth reset" });

      assert.equal(wsMgr.wsClients.size, 0);
      assert.deepEqual(ws._closed, { code: 1008, reason: "Auth reset" });
    });

    it("closes websockets for specific credential on close-credential-websockets", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("client-1", { ws: ws1, session: "alpha", credentialId: "cred-1", p2pPeer: null });
      wsMgr.wsClients.set("client-2", { ws: ws2, session: "alpha", credentialId: "cred-2", p2pPeer: null });

      bridge.relay({ type: "close-credential-websockets", credentialId: "cred-1" });

      assert.equal(wsMgr.wsClients.size, 1);
      assert.ok(wsMgr.wsClients.has("client-2"));
      assert.deepEqual(ws1._closed, { code: 1008, reason: "Credential revoked" });
      assert.equal(ws2._closed, null);
    });

    it("resize-sync excludes the active client", () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      wsMgr.wsClients.set("active-client", { ws: ws1, session: "alpha", p2pPeer: null, p2pConnected: false });
      wsMgr.wsClients.set("passive-client", { ws: ws2, session: "alpha", p2pPeer: null, p2pConnected: false });

      bridge.relay({ type: "resize-sync", session: "alpha", activeClientId: "active-client", cols: 120, rows: 40 });

      assert.equal(ws1.sent.length, 0, "active client should not receive resize-sync");
      assert.equal(ws2.sent.length, 1);
      assert.deepEqual(JSON.parse(ws2.sent[0]), { type: "resize-sync", cols: 120, rows: 40 });
    });
  });
});
