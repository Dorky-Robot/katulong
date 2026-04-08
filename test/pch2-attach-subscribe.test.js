/**
 * Integration tests: attach/subscribe snapshot sourcing.
 *
 * Raptor 3: both attachClient() and subscribeClient() take a snapshot
 * of the shared session ScreenState via session.snapshot(). The returned
 * shape is `{cols, rows, data, alive}` — the client passes `data` to
 * xterm.write() after resetting the terminal to the server-authoritative
 * `cols`/`rows`. There is no per-client replay, no RingBuffer tailing,
 * and no cursor/seq tracking.
 *
 * A shared ScreenState is the correct source of truth because it's
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
 * MockSession with a configurable snapshot result. The attach/subscribe
 * paths should surface this value unchanged — that's the behaviour every
 * test in this file pins.
 */
class MockSession extends BaseMockSession {
  constructor(name, tmuxName, options = {}) {
    super(name, tmuxName, options);
    this._snapData = "shared-snapshot-data";
  }

  async snapshot() {
    return {
      cols: this._cols,
      rows: this._rows,
      data: this._snapData,
      alive: this.alive,
    };
  }
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
// attachClient: snapshot comes from the shared session ScreenState
// -------------------------------------------------------------------
describe("attachClient snapshot (Raptor 3)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("returns the shared snapshot on attach", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._snapData = "shared-snap-value";

    const result = await mgr.attachClient("c1", "sess", 80, 24);
    assert.strictEqual(result.alive, true);
    assert.strictEqual(result.data, "shared-snap-value",
      "data should come from session.snapshot()");
    assert.strictEqual(typeof result.cols, "number");
    assert.strictEqual(typeof result.rows, "number");
  });

  it("returns the shared snapshot even when no cols/rows are supplied", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._snapData = "shared-fallback";

    const result = await mgr.attachClient("c1", "sess");
    assert.strictEqual(result.data, "shared-fallback");
  });

  it("returns an empty data string on attach when session is not alive", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session.state = MockSession.STATE_DETACHED;
    // Simulate the real Session.snapshot() contract when not alive.
    session._snapData = "";

    const result = await mgr.attachClient("c1", "sess", 80, 24);
    assert.strictEqual(result.data, "");
    assert.strictEqual(result.alive, false);
  });

  it("multiple clients attached to the same session both see the shared snapshot", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("sess");
    const session = mgr.getSession("sess");
    session._snapData = "multi-client";

    const r1 = await mgr.attachClient("c1", "sess", 80, 24);
    const r2 = await mgr.attachClient("c2", "sess", 120, 40);
    assert.strictEqual(r1.data, "multi-client");
    assert.strictEqual(r2.data, "multi-client");
  });
});

// -------------------------------------------------------------------
// subscribeClient: always returns a fresh snapshot (even on re-subscribe)
// -------------------------------------------------------------------
describe("subscribeClient snapshot (Raptor 3)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("returns shared snapshot on first subscribe", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    const bgSession = mgr.getSession("bg");
    bgSession._snapData = "bg-snapshot";

    await mgr.attachClient("c1", "main", 80, 24);
    const result = await mgr.subscribeClient("c1", "bg");

    assert.strictEqual(result.alive, true);
    assert.strictEqual(result.isNew, true);
    assert.strictEqual(result.data, "bg-snapshot",
      "first subscribe should return session.snapshot()");
  });

  it("returns a fresh snapshot on re-subscribe (Raptor 3 no-skip)", async () => {
    // Under the old protocol a re-subscribe returned an empty buffer to
    // avoid mid-frame garble. Under Raptor 3 the snapshot is the single
    // source of truth, so every subscribe serializes.
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    const bgSession = mgr.getSession("bg");
    bgSession._snapData = "bg-snapshot";

    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg");
    const result2 = await mgr.subscribeClient("c1", "bg");

    assert.strictEqual(result2.isNew, false,
      "isNew flag should still reflect first-vs-repeat subscription");
    assert.strictEqual(result2.data, "bg-snapshot",
      "re-subscribe should still return the current snapshot");
  });
});

// -------------------------------------------------------------------
// detachClient / unsubscribeClient / deleteSession: no crash w/o client map
// -------------------------------------------------------------------
describe("client lifecycle without per-client headless (Raptor 3)", () => {
  beforeEach(() => { tmuxSessions.clear(); });

  it("detachClient clears subscriptions and does not throw", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg");

    mgr.detachClient("c1");
    assert.strictEqual(mgr.isClientSubscribedTo("c1", "bg"), false,
      "subscription should be cleared on detach");
  });

  it("unsubscribeClient removes the subscription", async () => {
    const { mgr } = makeManager();
    await mgr.createSession("main");
    await mgr.createSession("bg");
    await mgr.attachClient("c1", "main", 80, 24);
    await mgr.subscribeClient("c1", "bg");
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
