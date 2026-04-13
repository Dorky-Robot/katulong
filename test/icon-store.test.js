import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_STATE,
  SET_ICON,
  REMOVE_ICON,
  RENAME,
  CLEAR,
  createIconStore,
} from "../public/lib/icon-store.js";

describe("icon-store reducer", () => {
  it("SET_ICON adds an icon", () => {
    const store = createIconStore();
    store.setIcon("s1", "terminal");
    assert.equal(store.getIcon("s1"), "terminal");
  });

  it("SET_ICON is idempotent for same value", () => {
    const store = createIconStore();
    store.setIcon("s1", "terminal");
    const state1 = store.getState();
    store.setIcon("s1", "terminal");
    assert.strictEqual(store.getState(), state1);
  });

  it("REMOVE_ICON removes an existing icon", () => {
    const store = createIconStore();
    store.setIcon("s1", "terminal");
    store.removeIcon("s1");
    assert.equal(store.getIcon("s1"), null);
  });

  it("REMOVE_ICON is a no-op for missing session", () => {
    const store = createIconStore();
    const state1 = store.getState();
    store.removeIcon("nonexistent");
    assert.strictEqual(store.getState(), state1);
  });

  it("RENAME moves icon from old to new name", () => {
    const store = createIconStore();
    store.setIcon("old", "code");
    store.rename("old", "new");
    assert.equal(store.getIcon("old"), null);
    assert.equal(store.getIcon("new"), "code");
  });

  it("RENAME is a no-op if old name has no icon", () => {
    const store = createIconStore();
    const state1 = store.getState();
    store.rename("ghost", "new");
    assert.strictEqual(store.getState(), state1);
  });

  it("getIcon returns null for unknown session", () => {
    const store = createIconStore();
    assert.equal(store.getIcon("nope"), null);
  });
});
