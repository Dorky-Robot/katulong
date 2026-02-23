import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SENSITIVE_ENV_VARS, getSafeEnv } from "../lib/env-filter.js";

describe("SENSITIVE_ENV_VARS", () => {
  it("contains SSH_PASSWORD", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("SSH_PASSWORD"));
  });

  it("contains SETUP_TOKEN", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("SETUP_TOKEN"));
  });

  it("contains KATULONG_NO_AUTH", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("KATULONG_NO_AUTH"));
  });

  it("contains CLAUDECODE", () => {
    assert.ok(SENSITIVE_ENV_VARS.has("CLAUDECODE"));
  });
});

describe("getSafeEnv", () => {
  // Stash and restore any pre-existing values
  let saved = {};
  const TEST_VARS = ["SSH_PASSWORD", "SETUP_TOKEN", "KATULONG_NO_AUTH", "CLAUDECODE"];

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

  it("filters SSH_PASSWORD from the returned environment", () => {
    process.env.SSH_PASSWORD = "super-secret";
    const env = getSafeEnv();
    assert.ok(!("SSH_PASSWORD" in env), "SSH_PASSWORD must not appear in safe env");
  });

  it("filters SETUP_TOKEN from the returned environment", () => {
    process.env.SETUP_TOKEN = "setup-secret";
    const env = getSafeEnv();
    assert.ok(!("SETUP_TOKEN" in env), "SETUP_TOKEN must not appear in safe env");
  });

  it("filters KATULONG_NO_AUTH from the returned environment", () => {
    process.env.KATULONG_NO_AUTH = "1";
    const env = getSafeEnv();
    assert.ok(!("KATULONG_NO_AUTH" in env), "KATULONG_NO_AUTH must not appear in safe env");
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
    process.env.SSH_PASSWORD = "should-stay";
    getSafeEnv();
    assert.equal(process.env.SSH_PASSWORD, "should-stay", "process.env must not be mutated");
  });

  it("returns a new object on each call", () => {
    const a = getSafeEnv();
    const b = getSafeEnv();
    assert.notEqual(a, b, "each call should return a distinct object");
  });

  it("filters all sensitive vars simultaneously when all are set", () => {
    process.env.SSH_PASSWORD = "pw";
    process.env.SETUP_TOKEN = "tok";
    process.env.KATULONG_NO_AUTH = "1";
    process.env.CLAUDECODE = "1";

    const env = getSafeEnv();
    assert.ok(!("SSH_PASSWORD" in env));
    assert.ok(!("SETUP_TOKEN" in env));
    assert.ok(!("KATULONG_NO_AUTH" in env));
    assert.ok(!("CLAUDECODE" in env));
  });
});
