import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeCommand, reconcileAgentPresence, reconcileClaudePresence,
  reconcileClaudeEnrichment,
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

  it("reconcileClaudePresence alias still resolves to the same implementation", () => {
    // Kept as an export so external callers that imported the old name
    // don't break during the transition. A single smoke assertion is
    // enough — the behavior is covered by the reconcileAgentPresence
    // suite above.
    assert.equal(reconcileClaudePresence, reconcileAgentPresence);
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
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, false, { discover });
    assert.equal(wrote, true);
    assert.deepEqual(session.meta.claude, { uuid: FOUND.uuid, startedAt: FOUND.startedAt });
  });

  it("probes every tick but no-ops when uuid matches", async () => {
    // Steady-state: discovery runs every tick to self-heal a stale
    // persisted uuid, but setMeta is only called when the value
    // actually differs. A single probe per tick is the intended cost.
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: FOUND.uuid, startedAt: FOUND.startedAt },
    });
    let probed = 0;
    let written = 0;
    const origSetMeta = session.setMeta.bind(session);
    session.setMeta = (ns, val) => { written += 1; return origSetMeta(ns, val); };
    const discover = async () => { probed += 1; return FOUND; };
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, false, { discover });
    assert.equal(wrote, false);
    assert.equal(probed, 1);
    assert.equal(written, 0);
  });

  it("refreshes a stale uuid without a presence transition (server-restart self-heal)", async () => {
    // Scenario: server restart reloaded session-mo55kw8w with a stale
    // persisted meta.claude.uuid from an earlier (buggy) discovery.
    // The pane is still running Claude, presenceChanged=false, but
    // discovery now returns the correct uuid. We must overwrite — no
    // dependency on a presence transition.
    const STALE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 1 },
      claude: { uuid: STALE, startedAt: 1 },
    });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, false, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.uuid, FOUND.uuid);
  });

  it("re-discovers on fresh start even when an old uuid is present", async () => {
    // Restart scenario: user quit Claude, started a new one in the same
    // pane. The enrichment reconciler must pick up the new uuid
    // regardless of whether presence flipped (covered by the stale-uuid
    // self-heal test above), but this case is the common one and
    // deserves its own assertion.
    const OLD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const session = makeSession({
      agent: { kind: "claude", running: true, detectedAt: 2 },
      claude: { uuid: OLD, startedAt: 1 },
    });
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, true, { discover });
    assert.equal(wrote, true);
    assert.equal(session.meta.claude.uuid, FOUND.uuid);
  });

  it("does nothing when pane_current_command is not a claude match", async () => {
    const session = makeSession();
    let probed = 0;
    const discover = async () => { probed += 1; return FOUND; };
    const wrote = await reconcileClaudeEnrichment(session, "bash", 1000, false, { discover });
    assert.equal(wrote, false);
    assert.equal(probed, 0);
    assert.equal(session.meta.claude, undefined);
  });

  it("does nothing when panePid is null (tmux hiccup)", async () => {
    const session = makeSession();
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", null, false, { discover });
    assert.equal(wrote, false);
    assert.equal(session.meta.claude, undefined);
  });

  it("does nothing when discovery returns null (file not yet written)", async () => {
    // Claude is booting: pane_current_command already flipped but
    // ~/.claude/sessions/<pid>.json isn't on disk yet. We tick again
    // next loop.
    const session = makeSession();
    const discover = async () => null;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, true, { discover });
    assert.equal(wrote, false);
    assert.equal(session.meta.claude, undefined);
  });

  it("swallows setMeta errors and returns false", async () => {
    const session = {
      name: "work", meta: {},
      setMeta: () => { throw new RangeError("nope"); },
    };
    const discover = async () => FOUND;
    const wrote = await reconcileClaudeEnrichment(session, "claude", 1000, true, { discover });
    assert.equal(wrote, false);
  });
});
