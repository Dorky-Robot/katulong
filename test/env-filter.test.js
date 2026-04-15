import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SENSITIVE_ENV_VARS, getSafeEnv } from "../lib/env-filter.js";

describe("SENSITIVE_ENV_VARS", () => {
  it("contains SETUP_TOKEN", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("SETUP_TOKEN"));
  });

  it("contains CLAUDECODE", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("CLAUDECODE"));
  });

  it("contains TMUX, TMUX_PANE, TMUX_TMPDIR", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("TMUX"));
    assert.ok(SENSITIVE_ENV_VARS.has("TMUX_PANE"));
    assert.ok(SENSITIVE_ENV_VARS.has("TMUX_TMPDIR"));
  });
});

describe("getSafeEnv", () => {
  // Stash and restore any pre-existing values
  let saved = {};
  const TEST_VARS = ["SETUP_TOKEN", "CLAUDECODE", "TMUX", "TMUX_PANE", "TMUX_TMPDIR"];

  beforeEach(() => {
    saved = {};
    for (const k of TEST_VARS) {
      saved[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TEST_VARS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("filters SETUP_TOKEN from the returned environment", () => {
    process.env.SETUP_TOKEN = "setup-secret";
    const env = getSafeEnv();
    assert.ok(!("SETUP_TOKEN" in env), "SETUP_TOKEN must not appear in safe env");
  });

  it("filters CLAUDECODE from the returned environment", () => {
    process.env.CLAUDECODE = "1";
    const env = getSafeEnv();
    assert.ok(!("CLAUDECODE" in env), "CLAUDECODE must not appear in safe env");
  });

  it("passes HOME through unfiltered", () => {
    const env = getSafeEnv();
    // HOME may or may not be set in all environments; only assert if present
    if (process.env.HOME !== undefined) {
      assert.equal(env.HOME, process.env.HOME);
    }
  });

  it("passes PATH through unfiltered", () => {
    const env = getSafeEnv();
    if (process.env.PATH !== undefined) {
      assert.equal(env.PATH, process.env.PATH);
    }
  });

  it("does not mutate process.env", () => {
    process.env.SETUP_TOKEN = "should-stay";
    getSafeEnv();
    assert.equal(process.env.SETUP_TOKEN, "should-stay", "process.env must not be mutated");
  });

  it("returns a new object on each call", () => {
    const a = getSafeEnv();
    const b = getSafeEnv();
    assert.notEqual(a, b, "each call should return a distinct object");
  });

  it("filters all sensitive vars simultaneously when all are set", () => {
    process.env.SETUP_TOKEN = "tok";
    process.env.CLAUDECODE = "1";

    const env = getSafeEnv();
    assert.ok(!("SETUP_TOKEN" in env));
    assert.ok(!("CLAUDECODE" in env));
  });

  it("filters TMUX, TMUX_PANE, TMUX_TMPDIR so outer-tmux state does not leak into spawned panes", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,11509,1";
    process.env.TMUX_PANE = "%1";
    process.env.TMUX_TMPDIR = "/private/tmp";

    const env = getSafeEnv();
    assert.ok(!("TMUX" in env), "TMUX must not leak (outer tmux server address)");
    assert.ok(!("TMUX_PANE" in env), "TMUX_PANE must not leak (breaks pane-to-session matching)");
    assert.ok(!("TMUX_TMPDIR" in env), "TMUX_TMPDIR must not leak");
  });
});
