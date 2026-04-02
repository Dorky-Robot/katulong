import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createClientTransport } from "../lib/client-transport.js";

/**
 * Mock WebSocket — uses the `ws` library interface (EventEmitter-style on/off).
 */
function mockWs() {
  const sent = [];
  const handlers = {};
  return {
    sent,
    readyState: 1,
    bufferedAmount: 0,
    send(data) { sent.push(data); },
    close(code, reason) { this._closed = { code, reason }; this.readyState = 3; },
    on(event, handler) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    off(event, handler) {
      if (!handlers[event]) return;
      handlers[event] = handlers[event].filter((h) => h !== handler);
    },
    ping() {},
    // Test helper: fire an event on this mock
    _emit(event, ...args) {
      for (const h of handlers[event] || []) h(...args);
    },
    _handlers: handlers,
  };
}

/**
 * Mock DataChannel — uses the browser RTCDataChannel interface (onmessage/onclose/onerror).
 */
function mockDc() {
  const sent = [];
  return {
    sent,
    readyState: "open",
    bufferedAmount: 0,
    send(data) { sent.push(data); },
    close() { this.readyState = "closed"; },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

describe("createClientTransport", () => {
  let ws;
  let transport;

  beforeEach(() => {
    ws = mockWs();
    transport = createClientTransport(ws);
  });

  // 1
  it("starts with websocket transport type", () => {
    assert.equal(transport.transportType, "websocket");
  });

  // 2
  it("send() routes to websocket initially", () => {
    transport.send("hello");
    assert.deepEqual(ws.sent, ["hello"]);
  });

  // 3
  it("readyState mirrors websocket", () => {
    assert.equal(transport.readyState, 1);
    ws.readyState = 0;
    assert.equal(transport.readyState, 0);
  });

  // 4
  it("bufferedAmount mirrors websocket", () => {
    assert.equal(transport.bufferedAmount, 0);
    ws.bufferedAmount = 4096;
    assert.equal(transport.bufferedAmount, 4096);
  });

  // 5
  it("upgradeToDataChannel switches transportType to datachannel", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");
  });

  // 6
  it("after upgrade, send() routes to datachannel", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    transport.send("via-dc");
    assert.deepEqual(dc.sent, ["via-dc"]);
    assert.deepEqual(ws.sent, []);
  });

  // 7
  it("after upgrade, bufferedAmount mirrors datachannel", () => {
    const dc = mockDc();
    dc.bufferedAmount = 2048;
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.bufferedAmount, 2048);
  });

  // 8
  it("after upgrade, ws property still returns the websocket", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.strictEqual(transport.ws, ws);
  });

  // 9
  it("downgradeToWebSocket switches back", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");
    transport.downgradeToWebSocket();
    assert.equal(transport.transportType, "websocket");
  });

  // 10
  it("after downgrade, send() routes back to websocket", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    transport.send("dc-msg");
    transport.downgradeToWebSocket();
    transport.send("ws-msg");
    assert.deepEqual(ws.sent, ["ws-msg"]);
    assert.deepEqual(dc.sent, ["dc-msg"]);
  });

  // 11
  it("message events from active transport are emitted", () => {
    const received = [];
    transport.on("message", (data) => received.push(data));

    // WebSocket is active — simulate a message from WS
    ws._emit("message", "ws-data");
    assert.deepEqual(received, ["ws-data"]);

    // Upgrade to DataChannel — simulate a message from DC
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.ok(dc.onmessage, "DataChannel onmessage handler should be set");
    dc.onmessage({ data: "dc-data" });
    assert.deepEqual(received, ["ws-data", "dc-data"]);
  });

  // 12
  it("message events from inactive transport are ignored for data delivery", () => {
    const received = [];
    transport.on("message", (data) => received.push(data));

    const dc = mockDc();
    transport.upgradeToDataChannel(dc);

    // WebSocket message while DataChannel is active — should be ignored
    ws._emit("message", "stale-ws-msg");
    assert.deepEqual(received, [], "WS messages should be ignored when DC is active");
  });

  // 13
  it("close event from datachannel triggers automatic downgrade", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");

    // Simulate DataChannel close
    dc.readyState = "closed";
    dc.onclose();

    assert.equal(transport.transportType, "websocket");
    // Verify send routes back to WS
    transport.send("after-dc-close");
    assert.deepEqual(ws.sent, ["after-dc-close"]);
  });

  // 14
  it("error event from datachannel triggers automatic downgrade", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");

    // Simulate DataChannel error
    dc.onerror(new Error("ice-failure"));

    assert.equal(transport.transportType, "websocket");
    transport.send("after-dc-error");
    assert.deepEqual(ws.sent, ["after-dc-error"]);
  });

  // Additional edge cases

  it("close() closes the active transport", () => {
    transport.close(1000, "normal");
    assert.equal(ws.readyState, 3);
  });

  it("close() on datachannel closes the datachannel", () => {
    const dc = mockDc();
    transport.upgradeToDataChannel(dc);
    transport.close(1000, "done");
    assert.equal(dc.readyState, "closed");
    // WS should remain open (alive for signaling)
    assert.equal(ws.readyState, 1);
  });

  it("on/off correctly adds and removes handlers", () => {
    const received = [];
    const handler = (data) => received.push(data);
    transport.on("message", handler);
    ws._emit("message", "first");
    transport.off("message", handler);
    ws._emit("message", "second");
    assert.deepEqual(received, ["first"]);
  });

  it("emits close events from the transport", () => {
    const closeCalls = [];
    transport.on("close", (...args) => closeCalls.push(args));
    ws._emit("close", 1006, "abnormal");
    assert.equal(closeCalls.length, 1);
    assert.deepEqual(closeCalls[0], [1006, "abnormal"]);
  });

  it("emits error events from the transport", () => {
    const errors = [];
    transport.on("error", (err) => errors.push(err));
    const testErr = new Error("test");
    ws._emit("error", testErr);
    assert.equal(errors.length, 1);
    assert.strictEqual(errors[0], testErr);
  });

  it("downgradeToWebSocket is a no-op when already on websocket", () => {
    assert.equal(transport.transportType, "websocket");
    transport.downgradeToWebSocket();
    assert.equal(transport.transportType, "websocket");
    transport.send("still-works");
    assert.deepEqual(ws.sent, ["still-works"]);
  });
});
