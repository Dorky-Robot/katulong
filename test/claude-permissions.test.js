/**
 * Permission-store + pre-tool-use-payload parser tests.
 *
 * Two kinds of coverage:
 *
 *   1. `createPermissionStore` — a pure in-memory Map with TTL expiry and
 *      at-most-once `resolve`. Tests use an injected clock + id generator
 *      so timing and request-id values are deterministic.
 *
 *   2. `parsePreToolUsePayload` — validator for Claude Code's
 *      `PreToolUse` hook. Extracts the uuid/pane/tool triple the
 *      pane scanner needs; rejects malformed payloads so the route
 *      handler doesn't have to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createPermissionStore,
  parsePreToolUsePayload,
} from "../lib/claude-permissions.js";

const UUID = "ff16582e-bbb4-49c6-90cf-e731be656442";

describe("createPermissionStore", () => {
  function makeStore({ start = 1000, ttlMs = 100 } = {}) {
    let clock = start;
    let n = 0;
    const store = createPermissionStore({
      ttlMs,
      now: () => clock,
      genId: () => `req-${++n}`,
    });
    return { store, advance: (ms) => { clock += ms; } };
  }

  it("add mints a sequential requestId and echoes the fields", () => {
    const { store } = makeStore();
    const rec = store.add({ uuid: UUID, message: "m", tool: "Bash", pane: "%3" });
    assert.equal(rec.requestId, "req-1");
    assert.equal(rec.uuid, UUID);
    assert.equal(rec.tool, "Bash");
    assert.equal(rec.pane, "%3");
    assert.equal(store.size(), 1);
  });

  it("resolve pops the record so double-click is a no-op", () => {
    const { store } = makeStore();
    const rec = store.add({ uuid: UUID });
    const first = store.resolve(rec.requestId);
    assert.equal(first.requestId, rec.requestId);
    const second = store.resolve(rec.requestId);
    assert.equal(second, null);
    assert.equal(store.size(), 0);
  });

  it("get leaves the record in place", () => {
    const { store } = makeStore();
    const rec = store.add({ uuid: UUID });
    assert.equal(store.get(rec.requestId).uuid, UUID);
    assert.equal(store.size(), 1);
  });

  it("expires records older than ttlMs on the next touch", () => {
    const { store, advance } = makeStore({ ttlMs: 100 });
    store.add({ uuid: UUID });
    advance(150);
    // Any method trips expiry; pick get() so we can assert the record is gone.
    assert.equal(store.get("req-1"), null);
    assert.equal(store.size(), 0);
  });

  it("keeps records that are still within ttl", () => {
    const { store, advance } = makeStore({ ttlMs: 100 });
    store.add({ uuid: UUID });
    advance(50);
    assert.equal(store.get("req-1")?.uuid, UUID);
  });

  it("returns null for unknown ids", () => {
    const { store } = makeStore();
    assert.equal(store.resolve("nope"), null);
    assert.equal(store.get("nope"), null);
  });

  it("findByUuid returns all pending requests for a session", () => {
    const { store } = makeStore();
    const a = store.add({ uuid: UUID, tool: "Bash" });
    const b = store.add({ uuid: UUID, tool: "Edit" });
    store.add({ uuid: "other-uuid", tool: "Write" });
    const hits = store.findByUuid(UUID).map((r) => r.requestId).sort();
    assert.deepEqual(hits, [a.requestId, b.requestId].sort());
  });

  it("findByUuid returns [] when the uuid is absent or falsy", () => {
    const { store } = makeStore();
    store.add({ uuid: UUID });
    assert.deepEqual(store.findByUuid("missing-uuid"), []);
    assert.deepEqual(store.findByUuid(null), []);
    assert.deepEqual(store.findByUuid(""), []);
  });
});

describe("parsePreToolUsePayload", () => {
  it("accepts a well-formed PreToolUse payload", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PreToolUse",
      session_id: UUID,
      tool_name: "Bash",
      tool_input: { command: "rm -f /tmp/foo" },
      _tmuxPane: "%7",
    });
    assert.equal(out.uuid, UUID);
    assert.equal(out.tool, "Bash");
    assert.equal(out.pane, "%7");
  });

  it("returns pane=null when the tmux pane stamp is missing", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PreToolUse",
      session_id: UUID,
      tool_name: "Bash",
    });
    assert.equal(out.pane, null);
  });

  it("drops a malformed pane id rather than echoing it", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PreToolUse",
      session_id: UUID,
      tool_name: "Bash",
      _tmuxPane: "not-a-pane",
    });
    assert.equal(out.pane, null);
  });

  it("drops a malformed tool name so it can't leak into logs/UI", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PreToolUse",
      session_id: UUID,
      tool_name: "Bash; rm -rf /",
      _tmuxPane: "%1",
    });
    assert.equal(out.tool, null);
  });

  it("rejects non-PreToolUse events", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PostToolUse",
      session_id: UUID,
      tool_name: "Bash",
    });
    assert.equal(out, null);
  });

  it("rejects payloads without a session_id", () => {
    const out = parsePreToolUsePayload({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    assert.equal(out, null);
  });
});
