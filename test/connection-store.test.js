import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_STATE,
  CONNECTING,
  READY,
  TRANSPORT_CHANGED,
  DISCONNECTED,
  reducer,
  createConnectionStore,
} from "../public/lib/connection-store.js";

// ─── Reducer unit tests ─────────────────────────────────────────────

describe("connection-store reducer", () => {
  it("initial state is EMPTY_STATE (disconnected, transport null)", () => {
    const state = reducer(undefined, { type: "@@INIT" });
    assert.deepStrictEqual(state, EMPTY_STATE);
    assert.equal(state.status, "disconnected");
    assert.equal(state.transport, null);
  });

  // ── Valid transitions ───────────────────────────────────────────

  it("CONNECTING: disconnected → connecting (transport stays null)", () => {
    const state = reducer(EMPTY_STATE, { type: CONNECTING });
    assert.equal(state.status, "connecting");
    assert.equal(state.transport, null);
  });

  it("READY: connecting → ready (transport set to 'websocket')", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: READY, transport: "websocket" });
    assert.equal(state.status, "ready");
    assert.equal(state.transport, "websocket");
  });

  it("READY: connecting → ready (transport set to 'datachannel')", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: READY, transport: "datachannel" });
    assert.equal(state.status, "ready");
    assert.equal(state.transport, "datachannel");
  });

  it("DISCONNECTED: ready → disconnected (transport reset to null)", () => {
    const ready = { status: "ready", transport: "websocket" };
    const state = reducer(ready, { type: DISCONNECTED });
    assert.equal(state.status, "disconnected");
    assert.equal(state.transport, null);
  });

  it("DISCONNECTED: connecting → disconnected (transport stays null)", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: DISCONNECTED });
    assert.equal(state.status, "disconnected");
    assert.equal(state.transport, null);
  });

  it("TRANSPORT_CHANGED: ready/websocket → ready/datachannel", () => {
    const ready = { status: "ready", transport: "websocket" };
    const state = reducer(ready, { type: TRANSPORT_CHANGED, transport: "datachannel" });
    assert.equal(state.status, "ready");
    assert.equal(state.transport, "datachannel");
  });

  it("TRANSPORT_CHANGED: ready/datachannel → ready/websocket", () => {
    const ready = { status: "ready", transport: "datachannel" };
    const state = reducer(ready, { type: TRANSPORT_CHANGED, transport: "websocket" });
    assert.equal(state.status, "ready");
    assert.equal(state.transport, "websocket");
  });

  // ── Invalid transitions (no-ops) ───────────────────────────────

  it("invalid: CONNECTING when already connecting → no-op", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: CONNECTING });
    assert.equal(state, connecting); // same reference
  });

  it("invalid: CONNECTING when ready → no-op", () => {
    const ready = { status: "ready", transport: "websocket" };
    const state = reducer(ready, { type: CONNECTING });
    assert.equal(state, ready);
  });

  it("invalid: READY when disconnected → no-op", () => {
    const state = reducer(EMPTY_STATE, { type: READY, transport: "websocket" });
    assert.equal(state, EMPTY_STATE);
  });

  it("invalid: READY when already ready → no-op", () => {
    const ready = { status: "ready", transport: "websocket" };
    const state = reducer(ready, { type: READY, transport: "datachannel" });
    assert.equal(state, ready);
  });

  it("invalid: TRANSPORT_CHANGED when disconnected → no-op", () => {
    const state = reducer(EMPTY_STATE, { type: TRANSPORT_CHANGED, transport: "websocket" });
    assert.equal(state, EMPTY_STATE);
  });

  it("invalid: TRANSPORT_CHANGED when connecting → no-op", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: TRANSPORT_CHANGED, transport: "websocket" });
    assert.equal(state, connecting);
  });

  // ── Invalid payloads ──────────────────────────────────────────

  it("invalid: READY with missing transport → no-op", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: READY });
    assert.equal(state, connecting);
  });

  it("invalid: READY with invalid transport value → no-op", () => {
    const connecting = { status: "connecting", transport: null };
    const state = reducer(connecting, { type: READY, transport: "smoke-signal" });
    assert.equal(state, connecting);
  });

  it("invalid: TRANSPORT_CHANGED with null transport → no-op", () => {
    const ready = { status: "ready", transport: "websocket" };
    const state = reducer(ready, { type: TRANSPORT_CHANGED, transport: null });
    assert.equal(state, ready);
  });

  // ── Invariants ────────────────────────────────────────────────

  it("invariant: disconnected always has null transport", () => {
    // Transition through full cycle and verify on each disconnected state
    let state = EMPTY_STATE;
    assert.equal(state.transport, null);

    state = reducer(state, { type: CONNECTING });
    state = reducer(state, { type: DISCONNECTED });
    assert.equal(state.status, "disconnected");
    assert.equal(state.transport, null);

    state = reducer(state, { type: CONNECTING });
    state = reducer(state, { type: READY, transport: "datachannel" });
    state = reducer(state, { type: DISCONNECTED });
    assert.equal(state.status, "disconnected");
    assert.equal(state.transport, null);
  });

  it("invariant: ready always has non-null transport", () => {
    const connecting = { status: "connecting", transport: null };

    let state = reducer(connecting, { type: READY, transport: "websocket" });
    assert.equal(state.status, "ready");
    assert.notEqual(state.transport, null);

    state = reducer(connecting, { type: READY, transport: "datachannel" });
    assert.equal(state.status, "ready");
    assert.notEqual(state.transport, null);

    // After TRANSPORT_CHANGED, still non-null
    state = reducer(
      { status: "ready", transport: "websocket" },
      { type: TRANSPORT_CHANGED, transport: "datachannel" }
    );
    assert.equal(state.status, "ready");
    assert.notEqual(state.transport, null);
  });

  it("unknown action type returns state unchanged", () => {
    const state = { status: "connecting", transport: null };
    const result = reducer(state, { type: "conn/NONEXISTENT" });
    assert.equal(result, state);
  });
});

// ─── Store integration tests ────────────────────────────────────────

describe("createConnectionStore", () => {
  let store;

  beforeEach(() => {
    store = createConnectionStore();
  });

  it("starts in EMPTY_STATE", () => {
    assert.deepStrictEqual(store.getState(), EMPTY_STATE);
  });

  it("subscriber fires on valid transition, receives (state, action, prevState)", () => {
    const calls = [];
    store.subscribe((state, action, prevState) => {
      calls.push({ state, action, prevState });
    });

    store.connecting();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].state.status, "connecting");
    assert.equal(calls[0].action.type, CONNECTING);
    assert.equal(calls[0].prevState.status, "disconnected");
  });

  it("subscriber does NOT fire on invalid/rejected transition", () => {
    const calls = [];
    store.subscribe(() => calls.push(true));

    // Already disconnected, DISCONNECTED should be no-op
    store.dispatch({ type: DISCONNECTED });
    assert.equal(calls.length, 0);

    // READY from disconnected is invalid
    store.dispatch({ type: READY, transport: "websocket" });
    assert.equal(calls.length, 0);
  });

  it("convenience: connecting()", () => {
    store.connecting();
    assert.equal(store.getState().status, "connecting");
  });

  it("convenience: ready('websocket')", () => {
    store.connecting();
    store.ready("websocket");
    assert.equal(store.getState().status, "ready");
    assert.equal(store.getState().transport, "websocket");
  });

  it("convenience: ready('datachannel')", () => {
    store.connecting();
    store.ready("datachannel");
    assert.equal(store.getState().status, "ready");
    assert.equal(store.getState().transport, "datachannel");
  });

  it("convenience: transportChanged('datachannel')", () => {
    store.connecting();
    store.ready("websocket");
    store.transportChanged("datachannel");
    assert.equal(store.getState().status, "ready");
    assert.equal(store.getState().transport, "datachannel");
  });

  it("convenience: disconnected()", () => {
    store.connecting();
    store.ready("websocket");
    store.disconnected();
    assert.deepStrictEqual(store.getState(), EMPTY_STATE);
  });

  it("full lifecycle: disconnect → connect → ready → transport change → disconnect", () => {
    assert.equal(store.getState().status, "disconnected");

    store.connecting();
    assert.equal(store.getState().status, "connecting");
    assert.equal(store.getState().transport, null);

    store.ready("websocket");
    assert.equal(store.getState().status, "ready");
    assert.equal(store.getState().transport, "websocket");

    store.transportChanged("datachannel");
    assert.equal(store.getState().status, "ready");
    assert.equal(store.getState().transport, "datachannel");

    store.disconnected();
    assert.equal(store.getState().status, "disconnected");
    assert.equal(store.getState().transport, null);
  });
});
