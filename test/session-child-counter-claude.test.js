import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeCommand, reconcileAgentPresence, reconcilePaneCwd, reconcilePaneGit,
} from "../lib/session-child-counter.js";
import { detectAgent } from "../lib/agent-presence.js";

describe("detectAgent (registry-driven classifier)", () => {
  it("classifies claude binary names as claude", () => {
    assert.equal(detectAgent("claude"), "claude");
    assert.equal(detectAgent("claude-code"), "claude");
  });

  it("classifies Claude's SemVer process title as claude", () => {
    // Observed via `tmux list-panes -F '#{pane_current_command}'` on macOS:
    // Claude Code overwrites its process title with the running version
    // (e.g. "2.1.107"). Tmux reads the title via kinfo_proc.p_comm on
    // BSD/macOS, so a live Claude Code pane never shows "claude".
    assert.equal(detectAgent("2.1.107"), "claude");
    assert.equal(detectAgent("2.2.0-beta.1"), "claude");
    assert.equal(detectAgent("3.0.0-rc.2"), "claude");
    assert.equal(detectAgent("2.1.109+build.42"), "claude");
  });

  it("returns null for shells, editors, and non-agent commands", () => {
    assert.equal(detectAgent("bash"), null);
    assert.equal(detectAgent("zsh"), null);
    assert.equal(detectAgent("vim"), null);
    assert.equal(detectAgent("node"), null);
  });

  it("rejects prefix-collision names", () => {
    assert.equal(detectAgent("claudemon"), null);
    assert.equal(detectAgent("claudesh"), null);
  });

  it("rejects numeric strings that aren't full SemVer", () => {
    assert.equal(detectAgent("1"), null);
    assert.equal(detectAgent("1.0"), null);
    assert.equal(detectAgent("12345"), null);
    assert.equal(detectAgent("127.0.0.1"), null);
    assert.equal(detectAgent("a.b.c"), null);
  });

  it("handles null / empty / non-string", () => {
    assert.equal(detectAgent(null), null);
    assert.equal(detectAgent(undefined), null);
    assert.equal(detectAgent(""), null);
    assert.equal(detectAgent(42), null);
  });
});

describe("isClaudeCommand (back-compat shim)", () => {
  it("returns true only for claude matches", () => {
    assert.equal(isClaudeCommand("claude"), true);
    assert.equal(isClaudeCommand("claude-code"), true);
    assert.equal(isClaudeCommand("2.1.109"), true);
    assert.equal(isClaudeCommand("bash"), false);
    assert.equal(isClaudeCommand(null), false);
  });
});

describe("reconcileAgentPresence", () => {
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

  it("flips running=true with kind on first agent detection", () => {
    const session = makeSession();
    const changed = reconcileAgentPresence(session, "claude");
    assert.equal(changed, true);
    assert.equal(session.meta.agent.kind, "claude");
    assert.equal(session.meta.agent.running, true);
    assert.equal(typeof session.meta.agent.detectedAt, "number");
  });

  it("is a no-op when the same kind is already running", () => {
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
    });
    const changed = reconcileAgentPresence(session, "claude");
    assert.equal(changed, false);
    assert.equal(session.meta.agent.detectedAt, 1);
  });

  it("clears meta.agent when command is no longer an agent", () => {
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
    });
    const changed = reconcileAgentPresence(session, "bash");
    assert.equal(changed, true);
    assert.equal(session.meta.agent, undefined);
  });

  it("does NOT touch meta.claude enrichment when clearing presence", () => {
    // meta.claude is owned by the hook route; presence flips must leave
    // it untouched so a watched feed tile keeps resolving after Claude
    // exits.
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: "11111111-2222-3333-4444-555555555555", startedAt: 12345 },
    });
    const changed = reconcileAgentPresence(session, "bash");
    assert.equal(changed, true);
    assert.equal(session.meta.agent, undefined);
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      startedAt: 12345,
    });
  });

  it("does NOT touch meta.claude enrichment when setting presence", () => {
    const session = makeSession({
      claude: { uuid: "11111111-2222-3333-4444-555555555555", startedAt: 12345 },
    });
    const changed = reconcileAgentPresence(session, "claude");
    assert.equal(changed, true);
    assert.equal(session.meta.agent.kind, "claude");
    assert.equal(session.meta.agent.running, true);
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      startedAt: 12345,
    });
  });

  it("treats null / empty current command as no-agent", () => {
    const session = makeSession();
    assert.equal(reconcileAgentPresence(session, null), false);
    assert.equal(reconcileAgentPresence(session, ""), false);
    assert.equal(session.meta.agent, undefined);
  });

  it("no-ops on clear when meta.agent was already absent", () => {
    const session = makeSession();
    const changed = reconcileAgentPresence(session, "bash");
    assert.equal(changed, false);
    assert.equal(session.meta.agent, undefined);
  });
});

describe("reconcilePaneCwd", () => {
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

  it("writes meta.pane.cwd on first observation", () => {
    const session = makeSession();
    const changed = reconcilePaneCwd(session, "/Users/x/proj");
    assert.equal(changed, true);
    assert.deepEqual(session.meta.pane, { cwd: "/Users/x/proj" });
  });

  it("no-ops when cwd is unchanged", () => {
    const session = makeSession({ pane: { cwd: "/Users/x/proj" } });
    let written = 0;
    const origSetMeta = session.setMeta.bind(session);
    session.setMeta = (ns, val) => { written += 1; return origSetMeta(ns, val); };
    const changed = reconcilePaneCwd(session, "/Users/x/proj");
    assert.equal(changed, false);
    assert.equal(written, 0);
  });

  it("updates meta.pane.cwd when cwd moves (user cd's)", () => {
    const session = makeSession({ pane: { cwd: "/Users/x/proj" } });
    const changed = reconcilePaneCwd(session, "/Users/x/proj/worktree");
    assert.equal(changed, true);
    assert.equal(session.meta.pane.cwd, "/Users/x/proj/worktree");
  });

  it("ignores null / empty paneCwd so tmux hiccups don't wipe the last-known value", () => {
    const session = makeSession({ pane: { cwd: "/Users/x/proj" } });
    assert.equal(reconcilePaneCwd(session, null), false);
    assert.equal(reconcilePaneCwd(session, ""), false);
    assert.equal(reconcilePaneCwd(session, undefined), false);
    assert.equal(session.meta.pane.cwd, "/Users/x/proj");
  });

  it("does not touch meta.claude (cross-namespace isolation)", () => {
    const session = makeSession({
      claude: { uuid: "11111111-2222-3333-4444-555555555555", cwd: "/claude/dir", startedAt: 1 },
    });
    reconcilePaneCwd(session, "/shell/dir");
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      cwd: "/claude/dir",
      startedAt: 1,
    });
    assert.equal(session.meta.pane.cwd, "/shell/dir");
  });

  it("preserves meta.pane.git when cwd updates (cross-field merge)", () => {
    const session = makeSession({
      pane: { cwd: "/a", git: { project: "repo", branch: "main", worktree: null } },
    });
    reconcilePaneCwd(session, "/b");
    assert.equal(session.meta.pane.cwd, "/b");
    assert.deepEqual(session.meta.pane.git, { project: "repo", branch: "main", worktree: null });
  });
});

describe("reconcilePaneGit", () => {
  function makeSession(initialMeta = {}, { alive = true } = {}) {
    return {
      name: "work",
      alive,
      meta: initialMeta,
      setMeta(ns, val) {
        if (val == null) delete this.meta[ns];
        else this.meta[ns] = val;
      },
    };
  }

  const GIT = { project: "repo", branch: "main", worktree: null };
  const stubProbe = (result) => async () => result;

  it("writes meta.pane.git on first observation", async () => {
    const session = makeSession({ pane: { cwd: "/a" } });
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(GIT) });
    assert.equal(changed, true);
    assert.deepEqual(session.meta.pane.git, GIT);
    assert.equal(session.meta.pane.cwd, "/a");
  });

  it("no-ops when git info is unchanged", async () => {
    const session = makeSession({ pane: { cwd: "/a", git: GIT } });
    let written = 0;
    const orig = session.setMeta.bind(session);
    session.setMeta = (ns, val) => { written += 1; return orig(ns, val); };
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(GIT) });
    assert.equal(changed, false);
    assert.equal(written, 0);
  });

  it("writes when branch flips in place (git checkout)", async () => {
    const session = makeSession({ pane: { cwd: "/a", git: GIT } });
    const next = { project: "repo", branch: "feat", worktree: null };
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(next) });
    assert.equal(changed, true);
    assert.equal(session.meta.pane.git.branch, "feat");
  });

  it("clears meta.pane.git when cwd is not a git repo", async () => {
    const session = makeSession({ pane: { cwd: "/a", git: GIT } });
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(null) });
    assert.equal(changed, true);
    assert.equal(session.meta.pane.git, null);
    assert.equal(session.meta.pane.cwd, "/a");
  });

  it("no-ops when git info is null and already null", async () => {
    const session = makeSession({ pane: { cwd: "/a", git: null } });
    let written = 0;
    const orig = session.setMeta.bind(session);
    session.setMeta = (ns, val) => { written += 1; return orig(ns, val); };
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(null) });
    assert.equal(changed, false);
    assert.equal(written, 0);
  });

  it("clears git when paneCwd becomes null", async () => {
    const session = makeSession({ pane: { cwd: "/a", git: GIT } });
    const changed = await reconcilePaneGit(session, null, { getGitInfo: stubProbe(GIT) });
    assert.equal(changed, true);
    assert.equal(session.meta.pane.git, null);
  });

  it("does not touch meta.claude", async () => {
    const session = makeSession({
      claude: { uuid: "11111111-2222-3333-4444-555555555555", cwd: "/c", startedAt: 1 },
      pane: { cwd: "/a" },
    });
    await reconcilePaneGit(session, "/a", { getGitInfo: stubProbe(GIT) });
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      cwd: "/c",
      startedAt: 1,
    });
  });

  it("skips setMeta when session dies during git probe", async () => {
    const session = makeSession({ pane: { cwd: "/a" } });
    // Probe flips the session to dead mid-await, mirroring a tmux kill.
    const probe = async () => { session.alive = false; return GIT; };
    const changed = await reconcilePaneGit(session, "/a", { getGitInfo: probe });
    assert.equal(changed, false);
    assert.equal(session.meta.pane.git, undefined);
  });
});
