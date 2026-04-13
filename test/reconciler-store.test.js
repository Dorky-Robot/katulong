import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_STATE,
  createReconcilerStore,
} from "../public/lib/reconciler-store.js";

describe("reconciler-store reducer", () => {
  it("starts at zero confirmations, empty key, bootDone false", () => {
    const store = createReconcilerStore();
    assert.deepStrictEqual(store.getState(), EMPTY_STATE);
  });

  it("confirm increments confirmations for same dead key", () => {
    const store = createReconcilerStore();
    store.confirm("key-a");
    assert.equal(store.getState().confirmations, 1);
    store.confirm("key-a");
    assert.equal(store.getState().confirmations, 2);
  });

  it("confirm resets counter when dead key changes", () => {
    const store = createReconcilerStore();
    store.confirm("key-a");
    store.confirm("key-a");
    assert.equal(store.getState().confirmations, 2);
    store.confirm("key-b");
    assert.equal(store.getState().confirmations, 1);
    assert.equal(store.getState().lastDeadKey, "key-b");
  });

  it("reset clears confirmations and lastDeadKey", () => {
    const store = createReconcilerStore();
    store.confirm("key-a");
    store.confirm("key-a");
    store.reset();
    assert.equal(store.getState().confirmations, 0);
    assert.equal(store.getState().lastDeadKey, "");
  });

  it("markBootDone sets bootDone to true", () => {
    const store = createReconcilerStore();
    store.markBootDone();
    assert.equal(store.getState().bootDone, true);
  });

  it("markBootDone is idempotent", () => {
    const store = createReconcilerStore();
    store.markBootDone();
    const state1 = store.getState();
    store.markBootDone();
    assert.strictEqual(store.getState(), state1);
  });

  it("reset does not affect bootDone", () => {
    const store = createReconcilerStore();
    store.markBootDone();
    store.confirm("key-a");
    store.reset();
    assert.equal(store.getState().bootDone, true);
    assert.equal(store.getState().confirmations, 0);
  });
});
