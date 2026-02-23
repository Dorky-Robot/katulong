import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTransportBridge } from "../lib/transport-bridge.js";

describe("createTransportBridge", () => {
  it("relays messages to registered subscribers", () => {
    const bridge = createTransportBridge();
    const received = [];
    bridge.register((msg) => received.push(msg));

    bridge.relay({ type: "output", session: "foo", data: "hello" });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { type: "output", session: "foo", data: "hello" });
  });

  it("relays to multiple subscribers", () => {
    const bridge = createTransportBridge();
    const a = [];
    const b = [];
    bridge.register((msg) => a.push(msg));
    bridge.register((msg) => b.push(msg));

    bridge.relay({ type: "exit", session: "s1", code: 0 });

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.deepEqual(a[0], b[0]);
  });

  it("stops relaying after unsubscribe", () => {
    const bridge = createTransportBridge();
    const received = [];
    const unsubscribe = bridge.register((msg) => received.push(msg));

    bridge.relay({ type: "output", session: "foo", data: "first" });
    unsubscribe();
    bridge.relay({ type: "output", session: "foo", data: "second" });

    assert.equal(received.length, 1);
    assert.equal(received[0].data, "first");
  });

  it("relay with no subscribers does not throw", () => {
    const bridge = createTransportBridge();
    assert.doesNotThrow(() => bridge.relay({ type: "output", session: "x", data: "y" }));
  });

  it("subscriber exception does not prevent other subscribers from running", () => {
    const bridge = createTransportBridge();
    const received = [];
    bridge.register(() => { throw new Error("boom"); });
    bridge.register((msg) => received.push(msg));

    // A throwing subscriber must not prevent subsequent subscribers from
    // receiving the message — one transport error must not affect others.
    assert.doesNotThrow(() => bridge.relay({ type: "exit", session: "s", code: 1 }));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { type: "exit", session: "s", code: 1 });
  });
});
