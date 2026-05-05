/**
 * Tests for inspectTmuxPane — the function that drives the chip bar.
 *
 * Why this test exists: in May 2026 the chip bar quietly broke on every
 * Apple Silicon host (mini, mac2024 in the user's mesh) for weeks. Root
 * cause: the format string used `\t` as the field separator, but tmux
 * 3.6a built against the Apple Silicon Homebrew toolchain silently
 * rewrites C0 control characters in format strings (tab → `_`), turning
 * `82724\t2.1.123\t/path` into `82724_2.1.123_/path`. The split fails,
 * the pid regex check fails, the function falls through to the
 * all-nulls early-exit silently. The same tmux 3.6a on Intel preserves
 * the tab, so the fix worked on some hosts and not others — perfect
 * recipe for "works on my machine."
 *
 * The lasting fix is to use a printable multi-char sentinel (`|@|`)
 * that's vanishingly unlikely to appear inside a pid (digits only),
 * command name, or absolute path. This test pins both halves of that
 * contract:
 *   1. The format string passed to tmux uses `|@|`, not `\t`.
 *   2. The parser splits on `|@|` and produces correct fields.
 *
 * Future-proofing: if anyone changes the separator back to `\t` (or any
 * non-printable byte that some tmux build might strip), this test
 * fails. The commit message of PR #710 has the full diagnosis.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const execCalls = [];
let execResponses = [];

mock.module("node:child_process", {
  namedExports: {
    execFile: (cmd, args, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      execCalls.push({ cmd, args: [...args] });
      const response = execResponses.shift() || { err: null, stdout: "", stderr: "" };
      if (cb) cb(response.err, response.stdout, response.stderr);
    },
  },
});

const { inspectTmuxPane } = await import("../lib/session-child-counter.js");

describe("inspectTmuxPane field separator", () => {
  beforeEach(() => {
    execCalls.length = 0;
    execResponses = [];
  });

  it("uses a printable multi-char sentinel, not a C0 control char", async () => {
    // Simulate tmux returning nothing — we only care about the args this round.
    execResponses = [{ err: null, stdout: "" }];
    await inspectTmuxPane("kat_test");

    const tmuxCall = execCalls.find((c) => c.cmd === "tmux");
    assert.ok(tmuxCall, "expected an execFile('tmux', ...) call");

    const formatArg = tmuxCall.args[tmuxCall.args.indexOf("-F") + 1];
    assert.ok(formatArg, "expected -F format argument");

    // The actual contract: every byte of the separator must be printable
    // ASCII (0x20–0x7E). Tabs, newlines, and other C0 controls are
    // rewritten by some tmux builds (see file header). This rule
    // catches ANY future regression to a stripped byte, not just a
    // revert to `\t`.
    const sep = formatArg.replace(/#\{[^}]+\}/g, "");
    for (let i = 0; i < sep.length; i++) {
      const code = sep.charCodeAt(i);
      assert.ok(
        code >= 0x20 && code <= 0x7E,
        `format-string separator byte 0x${code.toString(16)} at index ${i} ` +
        `is outside printable ASCII (0x20–0x7E). Some tmux builds rewrite ` +
        `non-printable bytes (notably \\t → _) in format strings, which ` +
        `silently breaks parsing. See PR #710.`
      );
    }
  });

  it("parses tmux output split by the same sentinel", async () => {
    // Drive the function with a real-shaped tmux response using the
    // `|@|` sentinel. If anyone changes the format string but forgets
    // to update the split, this catches it.
    execResponses = [
      { err: null, stdout: "12345|@|claude|@|/Users/me/proj\n" },
      { err: null, stdout: "" }, // pgrep returns no children
    ];
    const result = await inspectTmuxPane("kat_test");

    assert.equal(result.panePid, 12345);
    assert.equal(result.currentCommand, "claude");
    assert.equal(result.paneCwd, "/Users/me/proj");
    assert.equal(result.childCount, 0);
  });

  it("returns all nulls when tmux fails", async () => {
    execResponses = [{ err: new Error("tmux not found"), stdout: "" }];
    const result = await inspectTmuxPane("kat_test");
    assert.equal(result.panePid, null);
    assert.equal(result.currentCommand, null);
    assert.equal(result.paneCwd, null);
    assert.equal(result.childCount, 0);
  });
});
