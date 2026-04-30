/**
 * Tripwire: tests must NEVER run against the developer's real ~/.katulong/.
 *
 * Background — see commit history.
 * The daemon (LaunchAgent in lib/cli/commands/service.js, plus
 * `katulong-stage`) exports `KATULONG_DATA_DIR=<live dir>` into every
 * shell it spawns. Before this tripwire existed, running
 * `npm run test:unit` from a katulong tile silently wrote test
 * fixtures (id: "cred1", publicKey: "key1", user "user123" …) into
 * the live auth state, deleted the real WebAuthn credentials, and
 * booted every authenticated remote device.
 *
 * Two protections were added:
 *   1. lib/env-filter.js strips KATULONG_DATA_DIR / _TMUX_SOCKET from
 *      the env handed to PTY shells.
 *   2. test/helpers/setup-env.js unconditionally overrides
 *      KATULONG_DATA_DIR with a private mkdtemp() before any test
 *      module loads.
 *
 * This file is the third line: a test that fails loud and red the
 * moment either guard regresses, instead of silently corrupting state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import envConfig from "../lib/env-config.js";

describe("data dir isolation tripwire", () => {
  it("KATULONG_DATA_DIR is set to a private temp dir", () => {
    const value = process.env.KATULONG_DATA_DIR;
    assert.ok(
      value,
      "KATULONG_DATA_DIR must be set by test/helpers/setup-env.js",
    );
    assert.notEqual(
      value,
      join(homedir(), ".katulong"),
      "KATULONG_DATA_DIR must NOT point at the developer's real ~/.katulong",
    );
    assert.ok(
      value.startsWith(tmpdir()),
      `KATULONG_DATA_DIR must live under os.tmpdir() (got: ${value})`,
    );
  });

  it("envConfig.dataDir resolved against the test override, not the home dir", () => {
    assert.notEqual(
      envConfig.dataDir,
      join(homedir(), ".katulong"),
      "envConfig.dataDir must NOT resolve to ~/.katulong during tests — " +
        "if it does, KATULONG_DATA_DIR was unset at env-config import time " +
        "(check that --import setup-env.js is on the test command line)",
    );
    assert.equal(
      envConfig.dataDir,
      process.env.KATULONG_DATA_DIR,
      "envConfig.dataDir should mirror the env override exactly",
    );
  });

  it("KATULONG_TMUX_SOCKET points at a per-PID test socket, not 'katulong'", () => {
    const value = process.env.KATULONG_TMUX_SOCKET;
    assert.ok(
      value,
      "KATULONG_TMUX_SOCKET must be set by test/helpers/setup-env.js",
    );
    assert.notEqual(
      value,
      "katulong",
      "KATULONG_TMUX_SOCKET must not match the daemon's production socket name",
    );
    assert.match(
      value,
      /^katulong-test-\d+$/,
      `KATULONG_TMUX_SOCKET should look like katulong-test-<pid> (got: ${value})`,
    );
  });
});
