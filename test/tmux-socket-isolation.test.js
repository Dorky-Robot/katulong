/**
 * Tests for tmux socket isolation.
 *
 * When KATULONG_TMUX_SOCKET is set, every tmux invocation katulong makes
 * must prepend `-L <socket>` so it talks to an isolated tmux server instead
 * of the user's default socket. This is what keeps e2e test sessions out of
 * the developer's real tmux state (where tmux-continuum would snapshot and
 * restore them forever — the pollution this refactor exists to prevent).
 *
 * We test both layers:
 *   1. `tmuxSocketArgs()` returns the right args (or throws on a bad name)
 *   2. `tmuxExec()` actually prepends them when building the execFile call
 *
 * Like garble-tmux-passthrough.test.js, we mock child_process so no real
 * tmux binary is needed.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const execCalls = [];

mock.module("node:child_process", {
  namedExports: {
    execFile: (cmd, args, opts, cb) => {
      if (typeof opts === "function") cb = opts;
      execCalls.push({ cmd, args: [...args] });
      if (cb) cb(null, "", "");
    },
  },
});

const { tmuxSocketArgs, tmuxExec } = await import("../lib/tmux.js");

describe("tmuxSocketArgs", () => {
  const original = process.env.KATULONG_TMUX_SOCKET;
  afterEach(() => {
    if (original === undefined) delete process.env.KATULONG_TMUX_SOCKET;
    else process.env.KATULONG_TMUX_SOCKET = original;
  });

  it("returns [] when KATULONG_TMUX_SOCKET is unset", () => {
    delete process.env.KATULONG_TMUX_SOCKET;
    assert.deepEqual(tmuxSocketArgs(), []);
  });

  it("returns [] when KATULONG_TMUX_SOCKET is empty string", () => {
    process.env.KATULONG_TMUX_SOCKET = "";
    assert.deepEqual(tmuxSocketArgs(), []);
  });

  it("returns ['-L', name] when KATULONG_TMUX_SOCKET is a valid name", () => {
    process.env.KATULONG_TMUX_SOCKET = "katulong-e2e-0";
    assert.deepEqual(tmuxSocketArgs(), ["-L", "katulong-e2e-0"]);
  });

  it("accepts alphanumerics, underscore, and hyphen", () => {
    process.env.KATULONG_TMUX_SOCKET = "abc_123-XYZ";
    assert.deepEqual(tmuxSocketArgs(), ["-L", "abc_123-XYZ"]);
  });

  it("rejects socket names with slashes (path traversal)", () => {
    process.env.KATULONG_TMUX_SOCKET = "../evil";
    assert.throws(() => tmuxSocketArgs(), /KATULONG_TMUX_SOCKET/);
  });

  it("rejects socket names with shell metacharacters", () => {
    process.env.KATULONG_TMUX_SOCKET = "foo;rm -rf /";
    assert.throws(() => tmuxSocketArgs(), /KATULONG_TMUX_SOCKET/);
  });

  it("rejects socket names with spaces", () => {
    process.env.KATULONG_TMUX_SOCKET = "my socket";
    assert.throws(() => tmuxSocketArgs(), /KATULONG_TMUX_SOCKET/);
  });

  it("rejects socket names with dots", () => {
    process.env.KATULONG_TMUX_SOCKET = "katulong.e2e";
    assert.throws(() => tmuxSocketArgs(), /KATULONG_TMUX_SOCKET/);
  });
});

describe("tmuxExec socket prepending", () => {
  const original = process.env.KATULONG_TMUX_SOCKET;

  beforeEach(() => {
    execCalls.length = 0;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.KATULONG_TMUX_SOCKET;
    else process.env.KATULONG_TMUX_SOCKET = original;
  });

  it("does NOT prepend socket args when env var is unset", async () => {
    delete process.env.KATULONG_TMUX_SOCKET;
    await tmuxExec(["list-sessions"]);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args, ["list-sessions"]);
  });

  it("prepends ['-L', socket] when env var is set", async () => {
    process.env.KATULONG_TMUX_SOCKET = "katulong-e2e-2";
    await tmuxExec(["has-session", "-t", "foo"]);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args, [
      "-L", "katulong-e2e-2",
      "has-session", "-t", "foo",
    ]);
  });

  it("prepended args come BEFORE the tmux subcommand (tmux requires -L first)", async () => {
    process.env.KATULONG_TMUX_SOCKET = "test-sock";
    await tmuxExec(["kill-session", "-t", "sess"]);
    const { args } = execCalls[0];
    assert.equal(args[0], "-L");
    assert.equal(args[1], "test-sock");
    assert.equal(args[2], "kill-session");
  });
});
