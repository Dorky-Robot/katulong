/**
 * Integration tests: attach/subscribe snapshot sourcing.
 *
 * After PCH-7 deleted ClientHeadless, both attachClient() and
 * subscribeClient() serialize the shared session headless directly
 * (via session.serializeScreen()). These tests verify the happy path
 * and the re-subscribe carousel-swipe behavior.
 *
 * A shared session headless is the correct source of truth because it's
 * written live at the current PTY dims and resized in lockstep with tmux,
 * so it never drifts. See CLAUDE.md "Multi-device terminal dimensions —
 * inherent PTY limitation" for why per-client replay cannot work.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setupSessionManagerMocks,
  BaseMockSession,
  makeBridge,
  tmuxSessions,
} from "./helpers/session-manager-fixture.js";

/**
 * MockSession with a configurable serializeScreen result. The attach/
 * subscribe snapshot paths should surface this value unchanged — that's
 * the behaviour every test in this file pins.
 */
class MockSession extends BaseMockSession {
  constructor(name, tmuxName, options = {}) {
    super(name, tmuxName, options);
    this._serializeResult = "shared-headless-snapshot";
  }

  async serializeScreen() { return this._serializeResult; }
}

const { createSessionManager } = await setupSessionManagerMocks(MockSession);

function makeManager() {
  const bridge = makeBridge();
  const mgr = createSessionManager({
    bridge,
    shell: "/bin/sh",
    home: "/tmp",
  });
  return { mgr, bridge };
}

// -------------------------------------------------------------------
// attachClient: snapshot comes from the shared session headless
// -------------------------------------------------------------------
describe("attachClient snapshot (PCH-7)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("returns the shared headless snapshot on attach", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._serializeResult = "shared-snap-value";

    const result = await mgr.attachClient("c1", "sess", 80, 24);
    assert.strictEqual(result.alive, true);
    assert.strictEqual(result.buffer, "shared-snap-value",
      "buffer should be session.serializeScreen()");
  });

  it("returns the shared snapshot even when no cols/rows are supplied", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._serializeResult = "shared-fallback";

    const result = await mgr.attachClient("c1", "sess");
    assert.strictEqual(result.buffer, "shared-fallback");
  });

  it("returns an empty buffer on attach when session is not alive", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session.state = MockSession.STATE_DETACHED;

    const result = await mgr.attachClient("c1", "sess", 80, 24);
    assert.strictEqual(result.buffer, "");
    assert.strictEqual(result.alive, false);
  });

  it("multiple clients attached to the same session both see shared snapshot", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._serializeResult = "multi-client";

    const r1 = await mgr.attachClient("c1", "sess", 80, 24);
    const r2 = await mgr.attachClient("c2", "sess", 120, 40);
    assert.strictEqual(r1.buffer, "multi-client");
    assert.strictEqual(r2.buffer, "multi-client");
  });
});

// -------------------------------------------------------------------
// subscribeClient: first subscribe serializes; re-subscribe returns empty
// -------------------------------------------------------------------
describe("subscribeClient snapshot (PCH-7)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("returns shared snapshot on first subscribe", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    const bgSession = mgr.getSession("bg");
    bgSession._serializeResult = "bg-snapshot";

    await mgr.attachClient("c1", "main", 80, 24);
    const result = await mgr.subscribeClient("c1", "bg", 80, 24);

    assert.strictEqual(result.alive, true);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(result.buffer, "bg-snapshot",
      "first subscribe should return session.serializeScreen()");
  });

  it("skips serialization on re-subscribe (carousel swipe)", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);
    const result2 = await mgr.subscribeClient("c1", "bg", 80, 24);

    assert.strictEqual(result2.isNew, false);
    assert.strictEqual(result2.buffer, "", "re-subscribe should return empty buffer");
  });

  it("subscribe without cols/rows still returns shared snapshot", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    const bgSession = mgr.getSession("bg");
    bgSession._serializeResult = "no-dims-snap";

    await mgr.attachClient("c1", "main", 80, 24);
    const result = await mgr.subscribeClient("c1", "bg");
    assert.strictEqual(result.buffer, "no-dims-snap");
  });
});

// -------------------------------------------------------------------
// detachClient / unsubscribeClient / deleteSession: no crash w/o client map
// -------------------------------------------------------------------
describe("client lifecycle without per-client headless (PCH-7)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("detachClient clears subscriptions and does not throw", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);

    mgr.detachClient("c1");
    assert.strictEqual(mgr.isClientSubscribedTo("c1", "bg"), false,
      "subscription should be cleared on detach");
  });

  it("unsubscribeClient removes the subscription", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg", 80, 24);
    assert.strictEqual(mgr.isClientSubscribedTo("c1", "bg"), true);

    mgr.unsubscribeClient("c1", "bg");
    assert.strictEqual(mgr.isClientSubscribedTo("c1", "bg"), false);
  });

  it("deleteSession does not throw when clients are attached", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    await mgr.attachClient("c1", "sess", 80, 24);
    await mgr.attachClient("c2", "sess", 120, 40);

    const result = mgr.deleteSession("sess");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(mgr.getSession("sess"), undefined);
  });

  it("shutdown disposes cleanly with attached clients", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("s1");
    await mgr.createSession("s2");
    await mgr.attachClient("c1", "s1", 80, 24);
    await mgr.attachClient("c2", "s2", 120, 40);

    // Should not throw.
    mgr.shutdown();
  });
});
