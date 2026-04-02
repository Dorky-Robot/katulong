/**
 * Tests for transport-layer.js
 *
 * TDD: these tests were written FIRST, before the implementation.
 *
 * The transport layer wraps WebSocket + optional DataChannel behind a
 * unified interface. Only ONE transport carries data at a time. The
 * switch between WS and DC is atomic — no gap, no overlap.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { createTransportLayer } = await import("../public/lib/transport-layer.js");

// --- Browser-like mocks ---

function mockWebSocket() {
  return {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    sent: [],
    send(data) { this.sent.push(data); },
    close() { this.readyState = 3; },
    onmessage: null,
    onclose: null,
    onerror: null,
    addEventListener(type, fn) { this["on" + type] = fn; },
    removeEventListener(type, fn) { if (this["on" + type] === fn) this["on" + type] = null; },
  };
}

function mockDataChannel() {
  return {
    readyState: "open",
    bufferedAmount: 0,
    sent: [],
    send(data) { this.sent.push(data); },
    close() { this.readyState = "closed"; },
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

describe("createTransportLayer", () => {
  let ws;
  let transport;

  beforeEach(() => {
    ws = mockWebSocket();
    transport = createTransportLayer(ws);
  });

  // 1
  it("starts with websocket as active transport", () => {
    assert.equal(transport.transportType, "websocket");
  });

  // 2
  it("send() goes to websocket initially", () => {
    transport.send("hello");
    assert.deepEqual(ws.sent, ["hello"]);
  });

  // 3
  it("readyState mirrors websocket", () => {
    assert.equal(transport.readyState, 1);
    ws.readyState = 0;
    assert.equal(transport.readyState, 0);
    ws.readyState = 3;
    assert.equal(transport.readyState, 3);
  });

  // 4
  it("transportType is 'websocket' initially", () => {
    assert.equal(transport.transportType, "websocket");
  });

  // 5
  it("upgradeToDataChannel switches active transport", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");
  });

  // 6
  it("after upgrade, send() goes to datachannel", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    transport.send("data");
    assert.deepEqual(dc.sent, ["data"]);
    assert.deepEqual(ws.sent, [], "ws should not receive data after upgrade");
  });

  // 7
  it("after upgrade, transportType is 'datachannel'", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");
  });

  // 8
  it("after upgrade, ws property still accessible for signaling", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    assert.strictEqual(transport.ws, ws);
    // Can still send signaling via ws directly
    ws.send("signal");
    assert.deepEqual(ws.sent, ["signal"]);
  });

  // 9
  it("downgradeToWebSocket switches back", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    transport.downgradeToWebSocket();
    assert.equal(transport.transportType, "websocket");
  });

  // 10
  it("after downgrade, send() goes to websocket again", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    transport.downgradeToWebSocket();
    transport.send("back");
    assert.deepEqual(ws.sent, ["back"]);
    assert.deepEqual(dc.sent, [], "dc should not receive data after downgrade");
  });

  // 11
  it("onmessage receives from active transport only", () => {
    const received = [];
    transport.onmessage = (ev) => received.push(ev.data);

    // WS is active — WS message arrives
    ws.onmessage({ data: "from-ws" });
    assert.deepEqual(received, ["from-ws"]);

    // Upgrade to DC
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);

    // DC message arrives
    dc.onmessage({ data: "from-dc" });
    assert.deepEqual(received, ["from-ws", "from-dc"]);

    // WS message should NOT be forwarded while DC is active
    // (ws.onmessage was unwired for data — but ws stays alive for signaling)
    // The transport layer should not forward WS data messages when DC is active
    if (ws.onmessage) {
      ws.onmessage({ data: "ws-while-dc-active" });
    }
    assert.deepEqual(received, ["from-ws", "from-dc"],
      "WS messages should not be forwarded when DC is the active transport");
  });

  // 12
  it("DC close triggers automatic downgrade to WS", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");

    // Simulate DC close
    dc.onclose();
    assert.equal(transport.transportType, "websocket");

    // Should be able to send on WS again
    transport.send("recovered");
    assert.deepEqual(ws.sent, ["recovered"]);
  });

  // 13
  it("DC error triggers automatic downgrade to WS", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.transportType, "datachannel");

    // Simulate DC error
    dc.onerror(new Error("connection failed"));
    assert.equal(transport.transportType, "websocket");

    // Should be able to send on WS again
    transport.send("recovered");
    assert.deepEqual(ws.sent, ["recovered"]);
  });

  // 14
  it("close() closes both WS and DC", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    transport.close();
    assert.equal(ws.readyState, 3);
    assert.equal(dc.readyState, "closed");
  });

  // 14b — close() with no DC just closes WS
  it("close() with no datachannel just closes WS", () => {
    transport.close();
    assert.equal(ws.readyState, 3);
  });

  // 15
  it("upgrade during send doesn't lose data", () => {
    // Send goes to WS first
    transport.send("before");
    assert.deepEqual(ws.sent, ["before"]);

    // Now upgrade
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);

    // Next send goes to DC
    transport.send("after");
    assert.deepEqual(dc.sent, ["after"]);
    // WS only has the message from before upgrade
    assert.deepEqual(ws.sent, ["before"]);
  });

  // Additional edge case: readyState after upgrade reflects DC state
  it("readyState reflects datachannel state after upgrade", () => {
    const dc = mockDataChannel();
    dc.readyState = "open";
    transport.upgradeToDataChannel(dc);
    // DataChannel readyState 'open' maps to 1 (OPEN)
    assert.equal(transport.readyState, 1);
  });

  // Additional edge case: readyState for DC connecting
  it("readyState maps datachannel 'connecting' to 0", () => {
    const dc = mockDataChannel();
    dc.readyState = "connecting";
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.readyState, 0);
  });

  // Additional edge case: readyState for DC closing
  it("readyState maps datachannel 'closing' to 2", () => {
    const dc = mockDataChannel();
    dc.readyState = "closing";
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.readyState, 2);
  });

  // Additional edge case: readyState for DC closed
  it("readyState maps datachannel 'closed' to 3", () => {
    const dc = mockDataChannel();
    dc.readyState = "closed";
    transport.upgradeToDataChannel(dc);
    assert.equal(transport.readyState, 3);
  });

  // After downgrade, DC onclose/onerror should not cause double-downgrade
  it("DC events after manual downgrade are no-ops", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);
    transport.downgradeToWebSocket();
    assert.equal(transport.transportType, "websocket");

    // These should not throw or change state
    if (dc.onclose) dc.onclose();
    if (dc.onerror) dc.onerror(new Error("late error"));
    assert.equal(transport.transportType, "websocket");
  });

  // onmessage wiring updates when handler is set after upgrade
  it("onmessage set after upgrade wires to datachannel", () => {
    const dc = mockDataChannel();
    transport.upgradeToDataChannel(dc);

    const received = [];
    transport.onmessage = (ev) => received.push(ev.data);

    dc.onmessage({ data: "post-upgrade" });
    assert.deepEqual(received, ["post-upgrade"]);
  });

  // Replacing onmessage handler works
  it("replacing onmessage handler works", () => {
    const first = [];
    const second = [];
    transport.onmessage = (ev) => first.push(ev.data);
    ws.onmessage({ data: "a" });
    assert.deepEqual(first, ["a"]);

    transport.onmessage = (ev) => second.push(ev.data);
    ws.onmessage({ data: "b" });
    assert.deepEqual(first, ["a"], "old handler should not receive new messages");
    assert.deepEqual(second, ["b"]);
  });
});
