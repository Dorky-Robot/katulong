/**
 * Permission-store + notification-payload parser tests.
 *
 * Two kinds of coverage:
 *
 *   1. `createPermissionStore` — a pure in-memory Map with TTL expiry and
 *      at-most-once `resolve`. Tests use an injected clock + id generator
 *      so timing and request-id values are deterministic.
 *
 *   2. `parseNotificationPayload` — classifier for Claude Code's
 *      `Notification` hook. Only permission prompts should produce a
 *      record; idle-prompt notifications must be dropped so the feed
 *      doesn't render menu cards that have no meaningful action.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createPermissionStore,
  parseNotificationPayload,
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
});

describe("parseNotificationPayload", () => {
  it("accepts permission_prompt via matcher field", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      session_id: UUID,
      matcher: "permission_prompt",
      message: "Claude needs your permission to use Bash",
      _tmuxPane: "%7",
    });
    assert.equal(out.uuid, UUID);
    assert.equal(out.tool, "Bash");
    assert.equal(out.pane, "%7");
  });

  it("accepts permission_prompt via message_type field", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      session_id: UUID,
      message_type: "permission_prompt",
      message: "Claude needs permission to use Edit",
    });
    assert.equal(out.uuid, UUID);
    assert.equal(out.tool, "Edit");
  });

  it("falls back to the message text when matcher is absent", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      session_id: UUID,
      message: "Claude needs your permission to use WebFetch",
    });
    assert.equal(out.tool, "WebFetch");
  });

  it("rejects idle-prompt notifications (no action to offer)", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      session_id: UUID,
      matcher: "idle_prompt",
      message: "Claude has been idle for a while",
    });
    assert.equal(out, null);
  });

  it("rejects non-Notification events", () => {
    const out = parseNotificationPayload({
      hook_event_name: "PostToolUse",
      session_id: UUID,
      message: "ignored",
    });
    assert.equal(out, null);
  });

  it("rejects payloads without a session_id", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      matcher: "permission_prompt",
      message: "Claude needs permission to use Bash",
    });
    assert.equal(out, null);
  });

  it("drops a malformed pane id rather than echoing it", () => {
    const out = parseNotificationPayload({
      hook_event_name: "Notification",
      session_id: UUID,
      matcher: "permission_prompt",
      message: "Claude needs permission to use Bash",
      _tmuxPane: "not-a-pane",
    });
    assert.equal(out.pane, null);
  });
});
