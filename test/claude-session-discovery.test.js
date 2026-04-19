import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverClaudeSession } from "../lib/claude-session-discovery.js";

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
