/**
 * Session Manager Tests
 *
 * Tests session lifecycle, client tracking, spawn serialization,
 * session limits, and delete/detach behavior.
 *
 * Uses helpers/session-manager-fixture.js to set up the tmux/Session
 * mocks via mock.module — see that file for the rationale.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  setupSessionManagerMocks,
  BaseMockSession,
  makeBridge,
  tmuxSessions,
} from "./helpers/session-manager-fixture.js";

/**
 * MockSession with extra tracking fields used by tests in this file:
 *   - _written: array of write() arguments (for input-routing assertions)
 *   - _resizes: array of resize() calls (for resize-arbitration tests)
 *   - _seedCalls: array of seedScreen() calls (for adopt/seed tests)
 *   - _cols/_rows: latest resize dimensions
 */
class MockSession extends BaseMockSession {
  constructor(name, tmuxName, options = {}) {
    super(name, tmuxName, options);
    this._cols = 0;
    this._rows = 0;
    this._written = [];
    this._resizes = [];
    this._seedCalls = [];
  }

  async seedScreen(content, cursorPos) {
    this._seedCalls.push({ content, cursorPos });
  }
  write(data) { this._written.push(data); }
  resize(cols, rows) {
    this._resizes.push({ cols, rows });
    this._cols = cols;
    this._rows = rows;
  }
}

const { createSessionManager } = await setupSessionManagerMocks(MockSession);

function makeManager(overrides = {}) {
  const bridge = makeBridge();
  const mgr = createSessionManager({
    bridge,
    shell: "/bin/sh",
    home: "/tmp",
    ...overrides,
  });
  return { mgr, bridge };
}

describe("session manager", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  describe("createSession", () => {
    it("creates a session and returns its name and id", async () => {
      const { mgr } = makeManager();
      const result = await mgr.createSession("test1");
      assert.strictEqual(result.name, "test1");
      assert.strictEqual(typeof result.id, "string");
      assert.strictEqual(result.id.length, 21);
    });

    it("names the underlying tmux session `kat_<id>` (MC1e PR2)", async () => {
      const { mgr } = makeManager();
      const result = await mgr.createSession("display name with spaces");
      const session = mgr.getSession("display name with spaces");
      assert.strictEqual(session.tmuxName, `kat_${result.id}`,
        "tmux name must derive from the immutable id, not the display name");
      assert.ok(tmuxSessions.has(`kat_${result.id}`),
        "tmux-new-session must be invoked with the kat_<id> name");
    });

    it("captures the tmux pane id on spawn (MC1e PR2)", async () => {
      // The fixture's tmuxGetPaneId mock always returns "%1", so any
      // spawned session should surface that value in listSessions().
      const { mgr } = makeManager();
      await mgr.createSession("paned");
      const listed = mgr.listSessions().sessions[0];
      assert.strictEqual(listed.tmuxPane, "%1",
        "Session.toJSON must include the tmuxPane captured at spawn");
    });

    it("rejects duplicate session names", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("dup");
      const result = await mgr.createSession("dup");
      assert.ok(result.error, "Should return an error for duplicate name");
    });

    it("enforces session limit", async () => {
      const { mgr } = makeManager();
      // Create 20 sessions (the max)
      for (let i = 0; i < 20; i++) {
        const r = await mgr.createSession(`s${i}`);
        assert.strictEqual(r.name, `s${i}`);
      }
      // 21st should fail
      const result = await mgr.createSession("s20");
      assert.ok(result.error, "Should reject when at max sessions");
      assert.ok(result.error.includes("Maximum"), "Error should mention the limit");
    });
  });

  describe("listSessions", () => {
    it("returns empty list initially", () => {
      const { mgr } = makeManager();
      const result = mgr.listSessions();
      assert.deepStrictEqual(result.sessions, []);
    });

    it("lists created sessions", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      await mgr.createSession("b");
      const result = mgr.listSessions();
      assert.strictEqual(result.sessions.length, 2);
      const names = result.sessions.map(s => s.name);
      assert.ok(names.includes("a"));
      assert.ok(names.includes("b"));
    });

    it("strips PRIVATE_META_KEYS (transcriptPath) from returned meta", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      const session = mgr.getSession("a");
      session.setMeta("claude", {
        uuid: "11111111-2222-3333-4444-555555555555",
        startedAt: Date.now(),
        transcriptPath: "/Users/x/.claude/projects/y/11111111-2222-3333-4444-555555555555.jsonl",
      });
      const result = mgr.listSessions();
      const entry = result.sessions.find(s => s.name === "a");
      assert.ok(entry);
      assert.ok(entry.meta?.claude, "public meta.claude should survive the filter");
      assert.strictEqual(entry.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
      assert.strictEqual(entry.meta.claude.transcriptPath, undefined,
        "transcriptPath must not cross the REST boundary");
    });
  });

  describe("deleteSession", () => {
    it("deletes a session", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("del");
      const result = mgr.deleteSession("del");
      assert.deepStrictEqual(result, { ok: true, action: "deleted" });
      assert.strictEqual(mgr.listSessions().sessions.length, 0);

      const removed = bridge.messages.find(m => m.type === "session-removed");
      assert.ok(removed, "Should relay session-removed event");
      assert.strictEqual(removed.session, "del");
    });

    it("detaches a session without killing it", async () => {
      const { mgr } = makeManager();
      const created = await mgr.createSession("detach-me");
      const result = mgr.deleteSession("detach-me", { detachOnly: true });
      assert.deepStrictEqual(result, { ok: true, action: "detached" });
      assert.strictEqual(mgr.listSessions().sessions.length, 0);
      // tmux session should still exist (keyed by kat_<id> since MC1e PR2)
      assert.ok(tmuxSessions.has(`kat_${created.id}`), "tmux session should remain after detach");
    });

    it("returns error for nonexistent session", () => {
      const { mgr } = makeManager();
      const result = mgr.deleteSession("nope");
      assert.deepStrictEqual(result, { error: "Not found" });
    });
  });

  describe("renameSession", () => {
    it("renames a session and preserves id", async () => {
      const { mgr, bridge } = makeManager();
      const created = await mgr.createSession("old");
      const result = await mgr.renameSession("old", "new");
      assert.strictEqual(result.name, "new");
      assert.strictEqual(result.id, created.id, "rename must preserve id");
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
      assert.strictEqual(mgr.listSessions().sessions[0].name, "new");
      assert.strictEqual(mgr.listSessions().sessions[0].id, created.id);

      const renamed = bridge.messages.find(m => m.type === "session-renamed");
      assert.ok(renamed);
      assert.strictEqual(renamed.session, "old");
      assert.strictEqual(renamed.newName, "new");
      assert.strictEqual(renamed.id, created.id);
    });

    it("rejects rename to existing name", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("a");
      await mgr.createSession("b");
      const result = await mgr.renameSession("a", "b");
      assert.ok(result.error);
    });

    it("rejects rename of nonexistent session", async () => {
      const { mgr } = makeManager();
      const result = await mgr.renameSession("nope", "new");
      assert.ok(result.error);
    });

    it("does NOT rename the underlying tmux session (MC1e PR2)", async () => {
      // The source of rename-drift bugs was that every rename forked a
      // second name space (friendly name + tmux name) that slowly
      // decohered. After PR2, tmuxName is `kat_<id>` and never changes.
      const { mgr } = makeManager();
      const created = await mgr.createSession("original");
      await mgr.renameSession("original", "displayname");
      const session = mgr.getSession("displayname");
      assert.strictEqual(session.tmuxName, `kat_${created.id}`,
        "rename must not touch the tmux session name");
      assert.ok(tmuxSessions.has(`kat_${created.id}`),
        "kat_<id> tmux session must still exist after rename");
    });
  });

  describe("getSessionById", () => {
    it("returns the session matching the id", async () => {
      const { mgr } = makeManager();
      const { id } = await mgr.createSession("find-me");
      const session = mgr.getSessionById(id);
      assert.ok(session, "should find a session");
      assert.strictEqual(session.name, "find-me");
      assert.strictEqual(session.id, id);
    });

    it("returns undefined for unknown id", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("present");
      assert.strictEqual(mgr.getSessionById("bogusid"), undefined);
    });

    it("returns undefined for falsy inputs", () => {
      const { mgr } = makeManager();
      assert.strictEqual(mgr.getSessionById(null), undefined);
      assert.strictEqual(mgr.getSessionById(""), undefined);
      assert.strictEqual(mgr.getSessionById(undefined), undefined);
    });
  });

  describe("getSessionByPane", () => {
    it("returns the session whose tmuxPane matches", async () => {
      // The tmux mock in this test file returns "%1" for tmuxGetPaneId
      // (see the module mock at the top). So every adopted session ends
      // up with tmuxPane === "%1" — enough to verify lookup semantics.
      const { mgr } = makeManager();
      await mgr.createSession("paneful");
      const session = mgr.getSessionByPane("%1");
      assert.ok(session);
      assert.strictEqual(session.name, "paneful");
    });

    it("returns undefined for unknown pane", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("alpha");
      assert.strictEqual(mgr.getSessionByPane("%999"), undefined);
    });

    it("returns undefined for malformed pane (not %N)", () => {
      const { mgr } = makeManager();
      assert.strictEqual(mgr.getSessionByPane("3"), undefined);
      assert.strictEqual(mgr.getSessionByPane("%"), undefined);
      assert.strictEqual(mgr.getSessionByPane(null), undefined);
      assert.strictEqual(mgr.getSessionByPane(""), undefined);
    });
  });

  describe("client attach/detach", () => {
    it("attaches a client to a session and returns visible pane snapshot", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      const result = await mgr.attachClient("client1", "sess", 80, 24);
      assert.strictEqual(result.alive, true);
      assert.strictEqual(typeof result.buffer, "string");
    });

    it("creates session on attach if missing", async () => {
      const { mgr } = makeManager();
      const result = await mgr.attachClient("client1", "auto", 80, 24);
      assert.strictEqual(result.alive, true);
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });

    it("detaches client", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("client1", "sess", 80, 24);
      mgr.detachClient("client1");
      // No error — detach is fire-and-forget
    });
  });

  describe("writeInput", () => {
    it("writes to attached session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("sess");
      await mgr.attachClient("c1", "sess", 80, 24);
      mgr.writeInput("c1", "hello");
      // No error means success — mock captures writes
    });

    it("no-ops for unknown client", () => {
      const { mgr } = makeManager();
      mgr.writeInput("unknown", "data");
      // Should not throw
    });
  });

  describe("killTmuxSession", () => {
    it("rejects killing a managed session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("managed");
      const result = await mgr.killTmuxSession("managed");
      assert.ok(result.error);
      assert.ok(result.error.includes("managed"));
    });

    it("kills an unmanaged tmux session", async () => {
      const { mgr } = makeManager();
      tmuxSessions.set("orphan", true);
      const result = await mgr.killTmuxSession("orphan");
      assert.deepStrictEqual(result, { ok: true });
      assert.ok(!tmuxSessions.has("orphan"));
    });

    it("rejects invalid session names", async () => {
      const { mgr } = makeManager();
      const result = await mgr.killTmuxSession("../evil");
      assert.ok(result.error);
    });
  });

  describe("adoptTmuxSession", () => {
    it("adopts an existing tmux session", async () => {
      const { mgr } = makeManager();
      tmuxSessions.set("external", true);
      const result = await mgr.adoptTmuxSession("external");
      assert.strictEqual(result.name, "external");
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });

    it("rejects adopting already-managed session", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("mine");
      const result = await mgr.adoptTmuxSession("mine");
      assert.ok(result.error);
    });

    it("rejects invalid names", async () => {
      const { mgr } = makeManager();
      const result = await mgr.adoptTmuxSession("bad name!");
      assert.ok(result.error);
    });
  });

  describe("shutdown", () => {
    it("detaches all sessions without killing tmux", async () => {
      const { mgr } = makeManager();
      const a = await mgr.createSession("a");
      const b = await mgr.createSession("b");
      mgr.shutdown();
      // tmux sessions should still exist (kat_<id> keys as of MC1e PR2)
      assert.ok(tmuxSessions.has(`kat_${a.id}`));
      assert.ok(tmuxSessions.has(`kat_${b.id}`));
    });
  });

  describe("spawn serialization", () => {
    it("concurrent creates for same name both resolve without crash", async () => {
      const { mgr } = makeManager();
      // createSession checks sessions.has() before spawning, so the second
      // call returns "already exists" immediately. The important thing is
      // neither call throws or hangs.
      const [r1, r2] = await Promise.all([
        mgr.createSession("concurrent"),
        mgr.createSession("concurrent"),
      ]);
      const results = [r1, r2];
      const successes = results.filter(r => r.name === "concurrent");
      const errors = results.filter(r => r.error);
      // At least one succeeds, at least one errors — exact split depends on timing
      assert.ok(successes.length >= 1, "At least one should succeed");
      assert.strictEqual(successes.length + errors.length, 2, "Both should resolve");
    });

    it("concurrent attaches to same missing session serialize correctly", async () => {
      const { mgr } = makeManager();
      // attachClient auto-creates missing sessions via spawnSession.
      // Two concurrent attaches to the same non-existent session should
      // both succeed via pendingOps serialization.
      const [r1, r2] = await Promise.all([
        mgr.attachClient("c1", "shared", 80, 24),
        mgr.attachClient("c2", "shared", 80, 24),
      ]);
      assert.strictEqual(r1.alive, true);
      assert.strictEqual(r2.alive, true);
      // Only one session should exist
      assert.strictEqual(mgr.listSessions().sessions.length, 1);
    });
  });

  describe("flushes queued output on lifecycle events (regression)", () => {
    // Past bug: attach/subscribe/delete/rename called cancelNotification(),
    // which cleared the 2ms/16ms coalescer timers WITHOUT emitting the
    // queued bytes. Already-subscribed clients silently lost output between
    // the last %output burst and the next one — for a quiescent TUI mid-
    // redraw, this was a true liveness hole. The fix flushes instead of
    // cancelling so currently-routed clients always receive what was queued.
    function primeCoalescer(session) {
      // Plant some bytes in the RingBuffer mock and notify the manager
      // exactly the way Session does on incoming %output.
      session.outputBuffer.totalBytes = 100;
      session.outputBuffer.sliceFrom = (from) => (from === 0 ? "queued bytes" : "");
      session._options.onData(session.name, 0);
    }

    it("attachClient flushes queued output before snapshotting", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.attachClient("c1", "multi", 80, 24);
      const session = mgr.getSession("multi");
      bridge.messages.length = 0;

      primeCoalescer(session);
      await mgr.attachClient("c2", "multi", 80, 24);

      const output = bridge.messages.find(m => m.type === "output" && m.session === "multi");
      assert.ok(output, "queued output should be flushed before attach completes");
      assert.strictEqual(output.data, "queued bytes");
      assert.strictEqual(output.fromSeq, 0);
      assert.strictEqual(output.cursor, 100);
      mgr.shutdown();
    });

    it("subscribeClient flushes queued output before snapshotting", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("sub-target");
      const session = mgr.getSession("sub-target");
      bridge.messages.length = 0;

      primeCoalescer(session);
      await mgr.subscribeClient("c1", "sub-target", 80, 24);

      const output = bridge.messages.find(m => m.type === "output" && m.session === "sub-target");
      assert.ok(output, "queued output should be flushed before subscribe completes");
      assert.strictEqual(output.data, "queued bytes");
      mgr.shutdown();
    });

    it("deleteSession flushes queued output before removing the session", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("doomed");
      const session = mgr.getSession("doomed");
      bridge.messages.length = 0;

      primeCoalescer(session);
      mgr.deleteSession("doomed");

      const output = bridge.messages.find(m => m.type === "output" && m.session === "doomed");
      assert.ok(output, "queued output should be flushed before delete");
      assert.strictEqual(output.data, "queued bytes");
      // session-removed should also still be relayed after the flush
      assert.ok(bridge.messages.find(m => m.type === "session-removed" && m.session === "doomed"));
      mgr.shutdown();
    });

    it("renameSession flushes queued output under the old name", async () => {
      const { mgr, bridge } = makeManager();
      await mgr.createSession("old-name");
      const session = mgr.getSession("old-name");
      bridge.messages.length = 0;

      primeCoalescer(session);
      await mgr.renameSession("old-name", "new-name");

      const output = bridge.messages.find(m => m.type === "output");
      assert.ok(output, "queued output should be flushed under the old name before rename");
      assert.strictEqual(output.session, "old-name");
      assert.strictEqual(output.data, "queued bytes");
      mgr.shutdown();
    });
  });

  describe("seedScreen on adopt", () => {
    it("seeds the headless terminal with captured pane content on session create", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("seeded");
      const session = mgr.getSession("seeded");
      assert.ok(session._seedCalls.length > 0, "seedScreen should be called on session creation");
      assert.strictEqual(session._seedCalls[0].content, "$ prompt\n");
    });

    it("seeds with cursor position from tmux", async () => {
      const { mgr } = makeManager();
      await mgr.createSession("seeded-cursor");
      const session = mgr.getSession("seeded-cursor");
      assert.ok(session._seedCalls.length > 0);
      const call = session._seedCalls[0];
      assert.deepStrictEqual(call.cursorPos, { row: 1, col: 10 });
    });

    it("seeds adopted tmux sessions", async () => {
      const { mgr } = makeManager();
      tmuxSessions.set("ext-seed", true);
      await mgr.adoptTmuxSession("ext-seed");
      const session = mgr.getSession("ext-seed");
      assert.ok(session._seedCalls.length > 0, "seedScreen should be called on adopt");
      assert.strictEqual(session._seedCalls[0].content, "$ prompt\n");
    });
  });
});
