import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discoverClaudeSession,
  reconcileClaudeEnrichment,
} from "../lib/claude-session-discovery.js";

function makeDeps({ tree = {}, sessions = {} } = {}) {
  return {
    listChildren: async (pid) => [pid, ...(tree[pid] || [])],
    readSession: async (pid) => sessions[pid] || null,
  };
}

describe("discoverClaudeSession", () => {
  it("returns uuid/cwd/startedAt when a child pid has a valid session file", async () => {
    const deps = makeDeps({
      tree: { 1000: [1001, 1002] },
      sessions: {
        1002: {
          pid: 1002,
          sessionId: "11111111-2222-3333-4444-555555555555",
          cwd: "/Users/x/project",
          startedAt: 1776000000000,
          kind: "interactive",
          entrypoint: "cli",
        },
      },
    });
    const out = await discoverClaudeSession(1000, deps);
    assert.deepEqual(out, {
      uuid: "11111111-2222-3333-4444-555555555555",
      cwd: "/Users/x/project",
      startedAt: 1776000000000,
    });
  });

  it("resolves when Claude ran via exec — pane pid itself has the json", async () => {
    // `exec claude` leaves no intermediate shell: the pane pid IS the
    // claude process. listChildren includes the pane pid so this resolves.
    const deps = makeDeps({
      tree: { 2000: [] },
      sessions: {
        2000: {
          pid: 2000,
          sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          cwd: "/Users/x/exec",
          startedAt: 12345,
        },
      },
    });
    const out = await discoverClaudeSession(2000, deps);
    assert.equal(out.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    assert.equal(out.cwd, "/Users/x/exec");
  });

  it("returns null when no candidate pid has a session file", async () => {
    const deps = makeDeps({ tree: { 3000: [3001] }, sessions: {} });
    const out = await discoverClaudeSession(3000, deps);
    assert.equal(out, null);
  });

  it("skips candidates with malformed JSON and keeps looking", async () => {
    const deps = {
      listChildren: async () => [4000, 4001],
      readSession: async (pid) => {
        if (pid === 4000) return null; // simulates JSON parse fail
        if (pid === 4001) return {
          sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          cwd: "/Users/x/y",
          startedAt: 9,
        };
        return null;
      },
    };
    const out = await discoverClaudeSession(4000, deps);
    assert.equal(out.uuid, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("rejects records with relative or tilde-prefixed cwd", async () => {
    // A malformed session file with a non-absolute cwd must NOT propagate
    // into session meta. The frontend treats meta.claude.cwd as a
    // resolution base for file-link clicks; a value like "proj" or "~/x"
    // would either mis-resolve or fall through to meta.pane, and either
    // way shouldn't be trusted as-is from an on-disk file that an
    // attacker-controlled Claude process could write.
    const deps = makeDeps({
      tree: { 5500: [], 5600: [] },
      sessions: {
        5500: {
          sessionId: "11111111-2222-3333-4444-555555555555",
          cwd: "relative/path",
          startedAt: 1,
        },
        5600: {
          sessionId: "11111111-2222-3333-4444-555555555555",
          cwd: "~/home",
          startedAt: 1,
        },
      },
    });
    assert.equal(await discoverClaudeSession(5500, deps), null);
    assert.equal(await discoverClaudeSession(5600, deps), null);
  });

  it("rejects records with non-UUID sessionId", async () => {
    const deps = makeDeps({
      tree: { 5000: [] },
      sessions: {
        5000: { sessionId: "not-a-uuid", cwd: "/tmp", startedAt: 1 },
      },
    });
    const out = await discoverClaudeSession(5000, deps);
    assert.equal(out, null);
  });

  it("rejects records missing cwd", async () => {
    const deps = makeDeps({
      tree: { 6000: [] },
      sessions: {
        6000: {
          sessionId: "11111111-2222-3333-4444-555555555555",
          startedAt: 1,
        },
      },
    });
    const out = await discoverClaudeSession(6000, deps);
    assert.equal(out, null);
  });

  it("defaults startedAt to Date.now() when missing", async () => {
    const deps = makeDeps({
      tree: { 7000: [] },
      sessions: {
        7000: {
          sessionId: "11111111-2222-3333-4444-555555555555",
          cwd: "/tmp",
        },
      },
    });
    const before = Date.now();
    const out = await discoverClaudeSession(7000, deps);
    const after = Date.now();
    assert.ok(typeof out.startedAt === "number");
    assert.ok(out.startedAt >= before && out.startedAt <= after);
  });

  it("returns null for invalid pane pid input", async () => {
    assert.equal(await discoverClaudeSession(null), null);
    assert.equal(await discoverClaudeSession(undefined), null);
    assert.equal(await discoverClaudeSession(0), null);
    assert.equal(await discoverClaudeSession(-1), null);
    assert.equal(await discoverClaudeSession("not-a-number"), null);
  });

  it("accepts numeric string pid", async () => {
    const deps = makeDeps({
      tree: { 8000: [] },
      sessions: {
        8000: {
          sessionId: "11111111-2222-3333-4444-555555555555",
          cwd: "/tmp",
          startedAt: 1,
        },
      },
    });
    const out = await discoverClaudeSession("8000", deps);
    assert.equal(out.uuid, "11111111-2222-3333-4444-555555555555");
  });

  it("builds the ppid tree from a ps-style snapshot (macOS pgrep workaround)", async () => {
    // On macOS, `pgrep -P <parent>` silently returns no results when the
    // child has renamed its process.title (Claude Code sets it to a
    // SemVer string like "2.1.114"). The production path uses `ps -ax
    // -o pid=,ppid=` instead; this test pins the tree-walk against that
    // shape so a regression to pgrep would be caught here.
    const snapshot = async () => [
      { pid: 1, ppid: 0 },          // launchd
      { pid: 2000, ppid: 1 },       // tmux
      { pid: 28795, ppid: 2000 },   // pane shell (zsh -l)
      { pid: 29978, ppid: 28795 },  // claude (title rewritten to "2.1.114")
      { pid: 30100, ppid: 29978 },  // grandchild: claude tool subprocess
      { pid: 99999, ppid: 1 },      // unrelated
    ];
    const sessions = {
      29978: {
        sessionId: "ff16582e-bbb4-49c6-90cf-e731be656442",
        cwd: "/Users/x/proj",
        startedAt: 42,
      },
    };
    const out = await discoverClaudeSession(28795, {
      snapshot,
      readSession: async (pid) => sessions[pid] || null,
    });
    assert.equal(out.uuid, "ff16582e-bbb4-49c6-90cf-e731be656442");
    assert.equal(out.cwd, "/Users/x/proj");
  });

  it("walks two generations deep via the snapshot", async () => {
    // Grandchild pid carries the session file (e.g. pane shell →
    // wrapper script → claude). Tree walk must reach it.
    const snapshot = async () => [
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 }, // wrapper
      { pid: 300, ppid: 200 }, // claude
    ];
    const sessions = {
      300: {
        sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        cwd: "/tmp",
        startedAt: 1,
      },
    };
    const out = await discoverClaudeSession(100, {
      snapshot,
      readSession: async (pid) => sessions[pid] || null,
    });
    assert.equal(out.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });
});

describe("reconcileClaudeEnrichment", () => {
  function makeSession(initialMeta = {}) {
    return {
      name: "work",
      meta: initialMeta,
      setMeta(ns, val) {
        if (val == null) delete this.meta[ns];
        else this.meta[ns] = val;
      },
    };
  }
  const FOUND = {
    uuid: "11111111-2222-3333-4444-555555555555",
    cwd: "/Users/x/project",
    startedAt: 12345,
  };

  it("writes meta.claude when claude is running and uuid is missing", async () => {
    const session = makeSession({ agent: { kind: "claude", running: true, detectedAt: 1 } });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, true);
    assert.deepEqual(session.meta.claude, {
      uuid: FOUND.uuid,
      cwd: FOUND.cwd,
      startedAt: FOUND.startedAt,
    });
  });

  it("probes every tick but no-ops when uuid+cwd both match", async () => {
    // Steady-state: discovery runs every tick to self-heal a stale
    // persisted uuid, but setMeta is only called when the value
    // actually differs. Dedup is on the full (uuid, cwd) tuple so a
    // `claude --resume` into a different worktree still refreshes.
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: FOUND.uuid, cwd: FOUND.cwd, startedAt: FOUND.startedAt },
    });
    let probed = 0;
    let written = 0;
    const origSetMeta = session.setMeta.bind(session);
    session.setMeta = (ns, val) => { written += 1; return origSetMeta(ns, val); };
    const discover = async () => { probed += 1; return FOUND; };
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, false);
    assert.equal(probed, 1);
    assert.equal(written, 0);
  });

  it("refreshes cwd when uuid matches but cwd differs (resume into new worktree)", async () => {
    // `claude --resume <uuid>` keeps the uuid but can land in a
    // different directory. File-link resolution must follow the new cwd
    // or the user's click resolves against the prior worktree.
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: FOUND.uuid, cwd: "/old/path", startedAt: FOUND.startedAt },
    });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.cwd, FOUND.cwd);
  });

  it("preserves transcriptPath across monitor writes when uuid is unchanged", async () => {
    // The hook ingest path owns transcriptPath but the monitor also
    // writes meta.claude (full-replace semantics). Preserve the
    // cross-writer field so a monitor tick doesn't wipe out the
    // transcript pointer the feed tile reads.
    const session = makeSession({
      claude: {
        uuid: FOUND.uuid,
        cwd: "/old/path",
        startedAt: FOUND.startedAt,
        transcriptPath: `/Users/x/.claude/projects/proj/${FOUND.uuid}.jsonl`,
      },
    });
    const discover = async () => FOUND;
    await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(
      session.meta.claude.transcriptPath,
      `/Users/x/.claude/projects/proj/${FOUND.uuid}.jsonl`,
    );
    assert.equal(session.meta.claude.cwd, FOUND.cwd);
  });

  it("drops stale transcriptPath when uuid changes (new session)", async () => {
    // A transcriptPath scoped to the old uuid would resolve to the
    // wrong file if carried across a new-session boundary. Only
    // preserve when the uuid stays the same.
    const session = makeSession({
      claude: {
        uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        cwd: "/old",
        startedAt: 1,
        transcriptPath: "/Users/x/.claude/projects/old/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
      },
    });
    const discover = async () => FOUND;
    await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(session.meta.claude.uuid, FOUND.uuid);
    assert.equal(session.meta.claude.transcriptPath, undefined);
  });

  it("refreshes a stale uuid without a presence transition (server-restart self-heal)", async () => {
    // Scenario: server restart reloaded a session with a stale persisted
    // meta.claude.uuid from an earlier (buggy) discovery. The pane is
    // still running Claude and discovery now returns the correct uuid.
    // We must overwrite — no dependency on a presence transition.
    const STALE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: STALE, startedAt: 1 },
    });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.uuid, FOUND.uuid);
  });

  it("re-discovers on fresh start even when an old uuid is present", async () => {
    // Restart scenario: user quit Claude, started a new one in the same
    // pane. The enrichment reconciler must pick up the new uuid.
    const OLD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 2 },
      claude: { uuid: OLD, startedAt: 1 },
    });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.uuid, FOUND.uuid);
  });

  it("does nothing when pane_current_command is not a claude match", async () => {
    const session = makeSession();
    let probed = 0;
    const discover = async () => { probed += 1; return FOUND; };
    const wrote = await reconcileClaudeEnrichment(session, "bash", 1000, { discover });
    assert.equal(wrote, false);
    assert.equal(probed, 0);
    assert.equal(session.meta.claude, undefined);
  });

  it("does nothing when panePid is null (tmux hiccup)", async () => {
    const session = makeSession();
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", null, { discover });
    assert.equal(wrote, false);
    assert.equal(session.meta.claude, undefined);
  });

  it("does nothing when discovery returns null (file not yet written)", async () => {
    // Claude is booting: pane_current_command already flipped but
    // ~/.claude/sessions/<pid>.json isn't on disk yet. We tick again
    // next loop.
    const session = makeSession();
    const discover = async () => null;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, false);
    assert.equal(session.meta.claude, undefined);
  });

  it("preserves a transcriptPath written DURING the async discover() call", async () => {
    // Race: a SessionStart hook can land between reconcileClaudeEnrichment's
    // entry and its setMeta call, because discover() is async. If the
    // reconciler snapshots meta.claude at function entry (pre-await), it
    // sees no transcriptPath yet and silently wipes the hook's write.
    //
    // The fix is to re-read meta.claude at the point of write. This test
    // simulates the race by having discover() perform the concurrent hook
    // write before it resolves — any snapshot captured before the await
    // would miss it.
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
    });
    const HOOK_PATH = `/Users/x/.claude/projects/proj/${FOUND.uuid}.jsonl`;
    const discover = async () => {
      // Concurrent hook ingest fires while discover() is in flight.
      session.setMeta("claude", {
        uuid: FOUND.uuid,
        transcriptPath: HOOK_PATH,
      });
      return FOUND;
    };
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.transcriptPath, HOOK_PATH);
    assert.equal(session.meta.claude.cwd, FOUND.cwd);
  });

  it("swallows setMeta errors and returns false", async () => {
    const session = {
      name: "work", meta: {},
      setMeta: () => { throw new RangeError("nope"); },
    };
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, { discover });
    assert.equal(wrote, false);
  });
});
