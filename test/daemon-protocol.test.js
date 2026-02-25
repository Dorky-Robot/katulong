import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RPC_TYPES,
  FIRE_AND_FORGET_TYPES,
  BROADCAST_TYPES,
  ALL_TYPES,
  validateMessage,
} from "../lib/daemon-protocol.js";

describe("daemon-protocol constants", () => {
  it("RPC_TYPES contains expected types", () => {
    assert.ok(RPC_TYPES.has("list-sessions"));
    assert.ok(RPC_TYPES.has("create-session"));
    assert.ok(RPC_TYPES.has("delete-session"));
    assert.ok(RPC_TYPES.has("rename-session"));
    assert.ok(RPC_TYPES.has("attach"));
    assert.ok(RPC_TYPES.has("detach"));
    assert.ok(RPC_TYPES.has("get-shortcuts"));
    assert.ok(RPC_TYPES.has("set-shortcuts"));
  });

  it("FIRE_AND_FORGET_TYPES contains expected types", () => {
    assert.ok(FIRE_AND_FORGET_TYPES.has("input"));
    assert.ok(FIRE_AND_FORGET_TYPES.has("resize"));
    assert.ok(FIRE_AND_FORGET_TYPES.has("detach"));
  });

  it("BROADCAST_TYPES contains expected types", () => {
    assert.ok(BROADCAST_TYPES.has("output"));
    assert.ok(BROADCAST_TYPES.has("exit"));
    assert.ok(BROADCAST_TYPES.has("session-removed"));
    assert.ok(BROADCAST_TYPES.has("session-renamed"));
    assert.ok(BROADCAST_TYPES.has("child-count-update"));
  });

  it("ALL_TYPES is the union of all sets", () => {
    for (const t of RPC_TYPES) assert.ok(ALL_TYPES.has(t));
    for (const t of FIRE_AND_FORGET_TYPES) assert.ok(ALL_TYPES.has(t));
    for (const t of BROADCAST_TYPES) assert.ok(ALL_TYPES.has(t));
  });
});

describe("daemon-protocol validateMessage", () => {
  it("rejects null", () => {
    const result = validateMessage(null);
    assert.equal(result.valid, false);
  });

  it("rejects arrays", () => {
    const result = validateMessage([]);
    assert.equal(result.valid, false);
  });

  it("rejects missing type", () => {
    const result = validateMessage({ id: "1" });
    assert.equal(result.valid, false);
  });

  it("rejects non-string type", () => {
    const result = validateMessage({ type: 42 });
    assert.equal(result.valid, false);
  });

  it("rejects unknown type", () => {
    const result = validateMessage({ type: "unknown-type" });
    assert.equal(result.valid, false);
    assert.match(result.error, /Unknown message type/);
  });

  it("accepts valid list-sessions message", () => {
    const result = validateMessage({ type: "list-sessions" });
    assert.equal(result.valid, true);
  });

  it("accepts valid create-session message", () => {
    const result = validateMessage({ type: "create-session", name: "test" });
    assert.equal(result.valid, true);
  });

  it("rejects create-session without name", () => {
    const result = validateMessage({ type: "create-session" });
    assert.equal(result.valid, false);
    assert.match(result.error, /name/);
  });

  it("accepts valid input message", () => {
    const result = validateMessage({ type: "input", clientId: "c1", data: "hello" });
    assert.equal(result.valid, true);
  });

  it("rejects input without clientId", () => {
    const result = validateMessage({ type: "input", data: "hello" });
    assert.equal(result.valid, false);
    assert.match(result.error, /clientId/);
  });

  it("rejects input without data", () => {
    const result = validateMessage({ type: "input", clientId: "c1" });
    assert.equal(result.valid, false);
    assert.match(result.error, /data/);
  });

  it("accepts valid resize message", () => {
    const result = validateMessage({ type: "resize", clientId: "c1", cols: 80, rows: 24 });
    assert.equal(result.valid, true);
  });

  it("accepts valid output broadcast", () => {
    const result = validateMessage({ type: "output", session: "default", data: "hello" });
    assert.equal(result.valid, true);
  });

  it("accepts valid exit broadcast", () => {
    const result = validateMessage({ type: "exit", session: "default", code: 0 });
    assert.equal(result.valid, true);
  });

  it("accepts valid session-renamed broadcast", () => {
    const result = validateMessage({ type: "session-renamed", session: "old", newName: "new" });
    assert.equal(result.valid, true);
  });

  it("accepts valid child-count-update broadcast", () => {
    const result = validateMessage({ type: "child-count-update", session: "default", count: 3 });
    assert.equal(result.valid, true);
  });

  it("rejects child-count-update without count", () => {
    const result = validateMessage({ type: "child-count-update", session: "default" });
    assert.equal(result.valid, false);
    assert.match(result.error, /count/);
  });

  it("accepts valid rename-session message", () => {
    const result = validateMessage({ type: "rename-session", oldName: "old", newName: "new" });
    assert.equal(result.valid, true);
  });

  it("rejects rename-session without oldName", () => {
    const result = validateMessage({ type: "rename-session", newName: "new" });
    assert.equal(result.valid, false);
    assert.match(result.error, /oldName/);
  });

  it("accepts valid attach message", () => {
    const result = validateMessage({ type: "attach", clientId: "c1" });
    assert.equal(result.valid, true);
  });

  it("accepts valid set-shortcuts message", () => {
    const result = validateMessage({ type: "set-shortcuts", data: [] });
    assert.equal(result.valid, true);
  });

  it("accepts valid get-shortcuts message", () => {
    const result = validateMessage({ type: "get-shortcuts" });
    assert.equal(result.valid, true);
  });
});
