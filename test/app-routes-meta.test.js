import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  publicMeta, PRIVATE_META_KEYS, applyClaudeMetaFromHook, safeTranscriptPath,
} from "../lib/routes/app-routes.js";

const UUID_A = "11111111-2222-3333-4444-555555555555";

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

  it("strips private keys one level deep inside namespaces", () => {
    // session.meta shape is { [ns]: { ...fields } } — e.g.
    // meta.claude.transcriptPath — so the filter must recurse into
    // plain-object values, not just filter the top level.
    const out = publicMeta({
      claude: {
        uuid: "11111111-2222-3333-4444-555555555555",
        startedAt: 1700000000000,
        transcriptPath: "/Users/x/.claude/projects/y/abc.jsonl",
      },
      agent: { kind: "claude", running: true },
    });
    assert.deepEqual(out, {
      claude: { uuid: "11111111-2222-3333-4444-555555555555", startedAt: 1700000000000 },
      agent: { kind: "claude", running: true },
    });
  });

  it("leaves non-plain namespace values unchanged", () => {
    const out = publicMeta({
      tags: ["a", "b"],
      count: 3,
      label: null,
    });
    assert.deepEqual(out, { tags: ["a", "b"], count: 3, label: null });
  });
});

describe("safeTranscriptPath", () => {
  it("accepts a well-formed path whose uuid matches", () => {
    const p = `/Users/x/.claude/projects/-Users-x-proj/${UUID_A}.jsonl`;
    assert.equal(safeTranscriptPath(p, UUID_A), p);
  });

  it("rejects a path that doesn't start with /", () => {
    assert.equal(
      safeTranscriptPath(`Users/x/.claude/projects/s/${UUID_A}.jsonl`, UUID_A),
      null,
    );
  });

  it("rejects paths containing a .. segment", () => {
    assert.equal(
      safeTranscriptPath(`/x/.claude/projects/../../etc/${UUID_A}.jsonl`, UUID_A),
      null,
    );
  });

  it("rejects paths outside /.claude/projects/", () => {
    assert.equal(safeTranscriptPath(`/tmp/${UUID_A}.jsonl`, UUID_A), null);
  });

  it("rejects when filename uuid mismatches the session_id", () => {
    assert.equal(
      safeTranscriptPath(
        "/Users/x/.claude/projects/s/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
        UUID_A,
      ),
      null,
    );
  });

  it("rejects non-string / empty input", () => {
    assert.equal(safeTranscriptPath(null, UUID_A), null);
    assert.equal(safeTranscriptPath("", UUID_A), null);
    assert.equal(safeTranscriptPath(123, UUID_A), null);
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

  it("preserves meta.claude on SessionEnd — uuid must keep resolving after Claude exits", () => {
    // Watchlist subscribers need the uuid to remain addressable so the
    // transcript file (which lives on disk after Claude quits) can still
    // back feed replays. Clearing uuid on Stop was a bug — the transcript
    // is the source of truth, not the live Claude process.
    const { session, calls } = makeSession();
    session.meta.claude = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      startedAt: 1,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionEnd",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
    assert.equal(session.meta.claude.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("preserves meta.claude on Stop", () => {
    const { session, calls } = makeSession();
    session.meta.claude = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      startedAt: 1,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "Stop",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
    assert.equal(session.meta.claude.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
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

  it("adopts uuid from non-SessionStart events when meta.claude.uuid is missing", () => {
    // Scenario: hooks were installed after Claude started, so SessionStart
    // already fired and was lost. The next UserPromptSubmit / PreToolUse /
    // PostToolUse must still let the server learn the uuid, otherwise the
    // awaiting-Claude feed tile has no signal to swap on and stays blank
    // forever while events flow into `claude/<uuid>`.
    const { session, calls } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "PostToolUse",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.equal(calls.length, 1);
    assert.equal(session.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
    assert.equal(typeof session.meta.claude.startedAt, "number");
  });

  it("does NOT overwrite an existing uuid from non-SessionStart events", () => {
    // Once we have a uuid (from an earlier SessionStart or first adoption),
    // subsequent tool-use hooks must not thrash it. Only SessionStart is
    // allowed to replace a known uuid — that's the explicit new-session
    // signal.
    const { session, calls } = makeSession();
    session.meta.claude = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      startedAt: 100,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "PostToolUse",
      session_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
    assert.equal(session.meta.claude.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("adopting uuid does not touch meta.agent (pane-monitor namespace)", () => {
    // The pane monitor writes meta.agent = { kind, running, detectedAt }
    // independently. The hook writer must never stomp on a sibling
    // namespace — different writer, different keys.
    const { session } = makeSession();
    session.meta.agent = { kind: "claude", running: true, detectedAt: 100 };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.deepEqual(session.meta.agent, { kind: "claude", running: true, detectedAt: 100 });
    assert.equal(session.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
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

  it("SessionStart leaves meta.agent untouched", () => {
    // The pane monitor wrote meta.agent before the hook fired. The hook
    // writer owns meta.claude and must never stomp on the sibling
    // meta.agent namespace.
    const { session } = makeSession();
    session.meta.agent = { kind: "claude", running: true, detectedAt: 100 };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: "11111111-2222-3333-4444-555555555555",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.deepEqual(session.meta.agent, { kind: "claude", running: true, detectedAt: 100 });
    assert.equal(session.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
    assert.equal(typeof session.meta.claude.startedAt, "number");
  });

  it("SessionStart stamps meta.claude.transcriptPath when hook payload is safe", () => {
    // The SessionStart hook payload includes transcript_path — the
    // ground-truth location Claude Code writes to. Stamping it into
    // meta lets the watch route skip the fragile cwd-slug derivation
    // and read the file Claude Code is actually writing.
    const { session } = makeSession();
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
      transcript_path: `/Users/x/.claude/projects/-Users-x-proj/${UUID_A}.jsonl`,
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.equal(session.meta.claude.uuid, UUID_A);
    assert.equal(
      session.meta.claude.transcriptPath,
      `/Users/x/.claude/projects/-Users-x-proj/${UUID_A}.jsonl`,
    );
  });

  it("SessionStart drops transcript_path on traversal attempts", () => {
    const { session } = makeSession();
    applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
      transcript_path: `/Users/x/.claude/projects/../../../etc/${UUID_A}.jsonl`,
    }, makeManager(session));
    assert.equal(session.meta.claude.uuid, UUID_A);
    assert.equal(session.meta.claude.transcriptPath, undefined);
  });

  it("SessionStart drops transcript_path when uuid in filename doesn't match session_id", () => {
    const { session } = makeSession();
    applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
      transcript_path: "/Users/x/.claude/projects/slug/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
    }, makeManager(session));
    assert.equal(session.meta.claude.transcriptPath, undefined);
  });

  it("SessionStart drops transcript_path when it isn't under /.claude/projects/", () => {
    const { session } = makeSession();
    applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
      transcript_path: `/tmp/${UUID_A}.jsonl`,
    }, makeManager(session));
    assert.equal(session.meta.claude.transcriptPath, undefined);
  });

  it("SessionStart leaves transcriptPath unset when hook payload has no transcript_path", () => {
    // Back-compat: older hook shims, or non-SessionStart adoptions, don't
    // include transcript_path — the enrichment drops cleanly.
    const { session } = makeSession();
    applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(session.meta.claude.uuid, UUID_A);
    assert.equal(session.meta.claude.transcriptPath, undefined);
  });

  it("preserves meta.claude.cwd across hook writes when uuid is unchanged", () => {
    // The pane monitor stamps meta.claude.cwd from ~/.claude/sessions/
    // <pid>.json. When a hook event fires with the same uuid, the
    // hook writer must not wipe out cwd — file-link resolution on the
    // client depends on it surviving every tool-use tick.
    const { session } = makeSession();
    session.meta.claude = {
      uuid: UUID_A,
      cwd: "/Users/x/worktree",
      startedAt: 100,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.equal(session.meta.claude.cwd, "/Users/x/worktree");
  });

  it("drops pre-existing cwd when SessionStart brings a new uuid", () => {
    // A new session id means the prior cwd belongs to the old Claude
    // process — carrying it over would misresolve file links in the
    // new session's directory.
    const { session } = makeSession();
    session.meta.claude = {
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      cwd: "/Users/x/old",
      startedAt: 100,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionStart",
      session_id: UUID_A,
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, "set");
    assert.equal(session.meta.claude.uuid, UUID_A);
    assert.equal(session.meta.claude.cwd, undefined);
  });

  it("SessionEnd is a no-op — preserves meta.claude enrichment", () => {
    // SessionEnd no longer clears anything. meta.claude only carries the
    // transcript pointer (uuid + startedAt); "is Claude live?" now lives
    // on meta.agent, flipped by the pane monitor. Keeping the uuid means
    // a watched feed keeps resolving the on-disk transcript after exit.
    const { session, calls } = makeSession();
    session.meta.claude = {
      uuid: "11111111-2222-3333-4444-555555555555",
      startedAt: 1,
    };
    const verdict = applyClaudeMetaFromHook({
      hook_event_name: "SessionEnd",
      _tmuxPane: "%3",
    }, makeManager(session));
    assert.equal(verdict, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      startedAt: 1,
    });
  });
});
