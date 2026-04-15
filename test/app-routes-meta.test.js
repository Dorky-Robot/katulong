import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publicMeta, PRIVATE_META_KEYS, applyClaudeMetaFromHook } from "../lib/routes/app-routes.js";

describe("publicMeta", () => {
  it("strips known private keys", () => {
    const out = publicMeta({
      type: "progress",
      cwd: "/Users/x/project",
      transcriptPath: "/Users/x/.claude/projects/y/abc.jsonl",
    });
    assert.deepEqual(out, { type: "progress", cwd: "/Users/x/project" });
  });

  it("is a no-op when no private keys are present", () => {
    const in_ = { type: "log", label: "CI" };
    const out = publicMeta(in_);
    assert.deepEqual(out, in_);
    assert.notEqual(out, in_, "returns a fresh object, not the input");
  });

  it("returns non-object inputs unchanged", () => {
    assert.equal(publicMeta(null), null);
    assert.equal(publicMeta(undefined), undefined);
    assert.equal(publicMeta("string"), "string");
  });

  it("PRIVATE_META_KEYS lists transcriptPath", () => {
    // If this ever fails the filter has drifted — anyone adding a new
    // server-only field should update both the set and the broadcast
    // paths (see ensureTopicMeta / /api/topics / POST meta).
    assert.ok(PRIVATE_META_KEYS.has("transcriptPath"));
  });
});

describe("applyClaudeMetaFromHook", () => {
  function makeSession() {
    const calls = [];
    const session = {
      name: "work",
      tmuxPane: "%3",
      tmuxName: "kat_work",
      meta: {},
      setMeta(ns, val) {
        calls.push([ns, val]);
        if (val == null) delete this.meta[ns];
        else this.meta[ns] = val;
      },
    };
    return { session, calls };
  }
  function makeManager(session) {
    return {
      getSessionByPane(pane) {
        return session && session.tmuxPane === pane ? session : undefined;
      },
    };
  }

  it("writes meta.claude on SessionStart when pane resolves", () => {
    const { session, calls } = makeSession();
    const mgr = makeManager(session);
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, mgr);
    assert.equal(verdict, "set");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "claude");
    assert.equal(calls[0][1].uuid, "11111111-2222-3333-4444-555555555555");
    assert.equal(typeof calls[0][1].startedAt, "number");
    assert.equal(session.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
  });

  it("clears meta.claude on SessionEnd", () => {
    const { session, calls } = makeSession();
    session.meta.claude = { uuid: "old", startedAt: 1 };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionEnd",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "cleared");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], null);
    assert.equal(session.meta.claude, undefined);
  });

  it("clears meta.claude on Stop", () => {
    const { session } = makeSession();
    session.meta.claude = { uuid: "old", startedAt: 1 };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "Stop",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "cleared");
    assert.equal(session.meta.claude, undefined);
  });

  it("no-ops for unknown pane", () => {
    const { session, calls } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%99",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
  });

  it("no-ops for missing _tmuxPane", () => {
    const { session, calls } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
  });

  it("no-ops for malformed _tmuxPane (not %N)", () => {
    const { session, calls } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
  });

  it("no-ops for unhandled events (PostToolUse, SubagentStart, etc.)", () => {
    const { session, calls } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "PostToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
  });

  it("returns null and logs when setMeta throws", () => {
    const logs = [];
    const session = {
      name: "work", tmuxPane: "%3", tmuxName: "kat_work", meta: {},
      setMeta: () => { throw new RangeError("too big"); },
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session), { warn: (msg, meta) => logs.push([msg, meta]) });
    assert.equal(verdict, null);
    assert.equal(logs.length, 1);
  });

  it("returns null on non-object payload", () => {
    assert.equal(applyClaudeMetaFromHook(null, makeManager(null)), null);
    assert.equal(applyClaudeMetaFromHook("nope", makeManager(null)), null);
  });
});
