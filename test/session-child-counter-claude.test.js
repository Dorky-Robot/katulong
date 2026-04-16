import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeCommand, reconcileClaudePresence,
} from "../lib/session-child-counter.js";

describe("isClaudeCommand", () => {
  it("matches the claude binary name", () => {
    assert.equal(isClaudeCommand("claude"), true);
  });

  it("matches the long-form name", () => {
    assert.equal(isClaudeCommand("claude-code"), true);
  });

  it("does not match shells or editors", () => {
    assert.equal(isClaudeCommand("bash"), false);
    assert.equal(isClaudeCommand("zsh"), false);
    assert.equal(isClaudeCommand("vim"), false);
    assert.equal(isClaudeCommand("node"), false);
  });

  it("does not match prefix-collision names", () => {
    // tmux reports the basename, so arbitrary aliases that happen to start
    // with "claude" must not be treated as claude unless they are exactly
    // the allowed list.
    assert.equal(isClaudeCommand("claudemon"), false);
    assert.equal(isClaudeCommand("claudesh"), false);
  });

  it("matches the semver title that Claude Code sets at runtime", () => {
    // Observed via `tmux list-panes -F '#{pane_current_command}'` on macOS:
    // Claude Code overwrites its process title with the running version
    // (e.g. "2.1.107", "2.1.109"). Tmux's pane_current_command reads the
    // kinfo_proc p_comm / ucomm field on BSD+macOS, which reflects the
    // current title — not the original exec name — so plain "claude"
    // never hits for a live Claude Code pane.
    assert.equal(isClaudeCommand("2.1.107"), true);
    assert.equal(isClaudeCommand("2.1.108"), true);
    assert.equal(isClaudeCommand("2.1.109"), true);
    assert.equal(isClaudeCommand("2.1.110"), true);
  });

  it("matches semver with prerelease and build metadata", () => {
    assert.equal(isClaudeCommand("2.2.0-beta.1"), true);
    assert.equal(isClaudeCommand("3.0.0-rc.2"), true);
    assert.equal(isClaudeCommand("2.1.109+build.42"), true);
  });

  it("does not match arbitrary numeric strings", () => {
    // The semver matcher must not false-positive on pids, ports, IP
    // fragments, or short version-like strings Claude Code has never set.
    assert.equal(isClaudeCommand("1"), false);
    assert.equal(isClaudeCommand("1.0"), false);
    assert.equal(isClaudeCommand("12345"), false);
    assert.equal(isClaudeCommand("127.0.0.1"), false);
    assert.equal(isClaudeCommand("a.b.c"), false);
  });

  it("handles null / empty / non-string", () => {
    assert.equal(isClaudeCommand(null), false);
    assert.equal(isClaudeCommand(undefined), false);
    assert.equal(isClaudeCommand(""), false);
    assert.equal(isClaudeCommand(42), false);
  });
});

describe("reconcileClaudePresence", () => {
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

  it("flips running=true on first claude detection", () => {
    const session = makeSession();
    const changed = reconcileClaudePresence(session, "claude");
    assert.equal(changed, true);
    assert.equal(session.meta.claude.running, true);
    assert.equal(typeof session.meta.claude.detectedAt, "number");
  });

  it("is a no-op when already running", () => {
    const session = makeSession({ claude: { running: true, detectedAt: 1 } });
    const changed = reconcileClaudePresence(session, "claude");
    assert.equal(changed, false);
    assert.equal(session.meta.claude.detectedAt, 1);
  });

  it("clears running when command changes away from claude", () => {
    const session = makeSession({ claude: { running: true, detectedAt: 1 } });
    const changed = reconcileClaudePresence(session, "bash");
    assert.equal(changed, true);
    // The whole namespace is dropped since no hook-owned keys remained.
    assert.equal(session.meta.claude, undefined);
  });

  it("preserves hook-owned uuid/startedAt when clearing running", () => {
    const session = makeSession({
      claude: {
        running: true, detectedAt: 1,
        uuid: "11111111-2222-3333-4444-555555555555",
        startedAt: 12345,
      },
    });
    const changed = reconcileClaudePresence(session, "bash");
    assert.equal(changed, true);
    // Presence keys gone, hook keys survive so the feed button can still
    // resolve the topic for an already-tracked session.
    assert.deepEqual(session.meta.claude, {
      uuid: "11111111-2222-3333-4444-555555555555",
      startedAt: 12345,
    });
  });

  it("preserves hook-owned keys when setting running=true", () => {
    const session = makeSession({
      claude: {
        uuid: "11111111-2222-3333-4444-555555555555",
        startedAt: 12345,
      },
    });
    const changed = reconcileClaudePresence(session, "claude");
    assert.equal(changed, true);
    assert.equal(session.meta.claude.uuid, "11111111-2222-3333-4444-555555555555");
    assert.equal(session.meta.claude.startedAt, 12345);
    assert.equal(session.meta.claude.running, true);
  });

  it("treats null / empty current command as not-running", () => {
    const session = makeSession();
    assert.equal(reconcileClaudePresence(session, null), false);
    assert.equal(reconcileClaudePresence(session, ""), false);
    assert.equal(session.meta.claude, undefined);
  });

  it("no-ops on clear when meta.claude was already absent", () => {
    const session = makeSession();
    const changed = reconcileClaudePresence(session, "bash");
    assert.equal(changed, false);
    assert.equal(session.meta.claude, undefined);
  });
});
