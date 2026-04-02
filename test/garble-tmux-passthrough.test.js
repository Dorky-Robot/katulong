/**
 * Tests for tmux allow-passthrough option.
 *
 * Validates that tmuxNewSession, applyTmuxSessionOptions, and
 * setTmuxKatulongEnv all set allow-passthrough to "on" so that
 * DEC private mode sequences (e.g. Synchronized Output DECSET 2026)
 * pass through tmux to xterm.js instead of being silently stripped.
 *
 * Uses mock.module to replace child_process.execFile so no real
 * tmux binary is needed.
 */

import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Accumulates all execFile calls so tests can inspect tmux commands
const execCalls = [];

// mock.module must be called before importing the module under test.
// Mock child_process so tmuxExec records calls instead of spawning tmux.
const cpUrl = new URL("node:child_process", import.meta.url).href;

mock.module("node:child_process", {
  namedExports: {
    execFile: (cmd, args, opts, cb) => {
      // execFile(cmd, args, cb) — opts is optional
      if (typeof opts === "function") {
        cb = opts;
      }
      execCalls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    },
  },
});

const {
  tmuxNewSession,
  applyTmuxSessionOptions,
  setTmuxKatulongEnv,
} = await import("../lib/tmux.js");

/**
 * Find all captured execFile calls whose args contain every string in `needles`.
 */
function findCalls(...needles) {
  return execCalls.filter((call) =>
    needles.every((needle) => call.args.includes(needle))
  );
}

describe("tmux allow-passthrough", () => {
  beforeEach(() => {
    execCalls.length = 0;
  });

  describe("tmuxNewSession", () => {
    it("sets allow-passthrough on the new session", async () => {
      await tmuxNewSession("test-sess", 82, 24, "/bin/bash", {}, "/tmp");

      const matches = findCalls("set-option", "allow-passthrough");
      assert.ok(
        matches.length > 0,
        "expected at least one set-option call with allow-passthrough"
      );

      // Verify it targets the session name
      const perSession = matches.filter((c) => c.args.includes("test-sess"));
      assert.ok(
        perSession.length > 0,
        "allow-passthrough should target the session name"
      );
    });

    it("sets allow-passthrough value to 'on'", async () => {
      await tmuxNewSession("test-val", 80, 24, "/bin/bash", {}, "/tmp");

      const matches = findCalls("set-option", "allow-passthrough");
      for (const call of matches) {
        const idx = call.args.indexOf("allow-passthrough");
        const value = call.args[idx + 1];
        assert.equal(value, "on", "allow-passthrough value must be 'on'");
      }
    });
  });

  describe("applyTmuxSessionOptions", () => {
    it("includes allow-passthrough in session options", async () => {
      await applyTmuxSessionOptions("reattach-sess");

      const matches = findCalls("set-option", "allow-passthrough");
      assert.ok(
        matches.length > 0,
        "applyTmuxSessionOptions should set allow-passthrough"
      );

      // Verify it targets the session
      const perSession = matches.filter((c) =>
        c.args.includes("reattach-sess")
      );
      assert.ok(
        perSession.length > 0,
        "allow-passthrough should target the session name"
      );
    });

    it("sets allow-passthrough value to 'on'", async () => {
      await applyTmuxSessionOptions("val-check");

      const matches = findCalls("set-option", "allow-passthrough");
      assert.ok(matches.length > 0);
      for (const call of matches) {
        const idx = call.args.indexOf("allow-passthrough");
        assert.equal(call.args[idx + 1], "on");
      }
    });
  });

  describe("setTmuxKatulongEnv", () => {
    it("sets allow-passthrough globally", async () => {
      await setTmuxKatulongEnv("/usr/local/bin", 3000);

      const matches = findCalls("set-option", "allow-passthrough");
      assert.ok(
        matches.length > 0,
        "setTmuxKatulongEnv should set allow-passthrough"
      );

      // Verify it uses the global flag
      const global = matches.filter((c) => c.args.includes("-g"));
      assert.ok(
        global.length > 0,
        "allow-passthrough should be set with -g (global)"
      );
    });

    it("sets global allow-passthrough value to 'on'", async () => {
      await setTmuxKatulongEnv("/usr/local/bin", 3000);

      const matches = findCalls("set-option", "-g", "allow-passthrough");
      assert.ok(matches.length > 0);
      for (const call of matches) {
        const idx = call.args.indexOf("allow-passthrough");
        assert.equal(call.args[idx + 1], "on");
      }
    });
  });

  describe("value correctness", () => {
    it("never uses 'true', 'yes', or '1' — only 'on'", async () => {
      // Exercise all three functions
      await tmuxNewSession("chk", 80, 24, "/bin/bash", {}, "/tmp");
      await applyTmuxSessionOptions("chk2");
      await setTmuxKatulongEnv("/usr/local/bin", 3000);

      const matches = findCalls("allow-passthrough");
      assert.ok(matches.length >= 3, "expected at least 3 allow-passthrough calls");

      for (const call of matches) {
        const idx = call.args.indexOf("allow-passthrough");
        const value = call.args[idx + 1];
        assert.equal(value, "on", `allow-passthrough must be 'on', got '${value}'`);
        assert.notEqual(value, "true");
        assert.notEqual(value, "yes");
        assert.notEqual(value, "1");
      }
    });
  });
});
