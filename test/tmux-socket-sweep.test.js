/**
 * Tests for the orphan tmux socket sweep.
 *
 * The sweep exists to reap socket files left behind when a test process
 * is killed before its `process.on("exit")` handler can run — SIGKILL,
 * pre-push hook timeouts, CI runner timeouts, OOM. Without it,
 * `/tmp/tmux-$UID/` accumulates `katulong-test-*` sockets into the
 * thousands and destabilizes tmux itself (observed: 16k+ orphans
 * correlating with spontaneous tmux crashes).
 *
 * The sweep's contract: for sockets named `<prefix><pid>`, reap iff the
 * named PID is dead. These tests verify both the dead-pid reap path and
 * that alive pids / non-matching names are left alone.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  sweepOrphanTmuxSockets,
  tmuxSocketDir,
} from "../lib/tmux-socket-sweep.js";

const PREFIX = "katulong-test-sweeptst-";

function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Spawn and immediately await a short-lived process. Its PID is free
// once the call returns. PIDs can be reused, but not within the
// microseconds before the assertion — good enough for a test.
function freshDeadPid() {
  const r = spawnSync("true", [], { stdio: "ignore" });
  return r.pid;
}

describe("sweepOrphanTmuxSockets", () => {
  before(function () {
    if (!tmuxAvailable()) this.skip("tmux not installed");
  });

  // Safety net: any `<PREFIX>*` entries still on disk after this suite
  // are our own leaks. Clean up so we never contribute to the orphan
  // pile we're fighting.
  after(() => {
    try {
      for (const name of readdirSync(tmuxSocketDir())) {
        if (!name.startsWith(PREFIX)) continue;
        try { execFileSync("tmux", ["-L", name, "kill-server"], { stdio: "ignore" }); } catch {}
        try { unlinkSync(join(tmuxSocketDir(), name)); } catch {}
      }
    } catch {}
  });

  it("reaps a socket whose creator PID is dead (covers SIGKILL leak mode)", () => {
    const deadPid = freshDeadPid();
    const name = `${PREFIX}${deadPid}`;
    const path = join(tmuxSocketDir(), name);
    // Start a real tmux anchor on this socket so it's a genuine socket
    // file — exercising the "orphaned but alive" leak mode where tmux
    // keeps running after the test process died.
    execFileSync("tmux", ["-L", name, "new-session", "-d", "-s", "__anchor__"], { stdio: "ignore" });
    assert.ok(existsSync(path), "setup: socket should exist");

    const removed = sweepOrphanTmuxSockets(PREFIX);

    assert.equal(removed, 1, "sweep should report one removal");
    assert.equal(existsSync(path), false, "orphan socket should be unlinked");
  });

  it("leaves sockets alone whose creator PID is alive", () => {
    // Use our own PID — guaranteed alive for the duration of this test.
    const name = `${PREFIX}${process.pid}`;
    const path = join(tmuxSocketDir(), name);
    execFileSync("tmux", ["-L", name, "new-session", "-d", "-s", "__anchor__"], { stdio: "ignore" });
    try {
      const removed = sweepOrphanTmuxSockets(PREFIX);
      assert.equal(removed, 0, "alive creator must not be swept");
      assert.ok(existsSync(path), "live socket must remain after sweep");
    } finally {
      try { execFileSync("tmux", ["-L", name, "kill-server"], { stdio: "ignore" }); } catch {}
      try { unlinkSync(path); } catch {}
    }
  });

  it("ignores entries whose suffix is not a PID", () => {
    // Sockets matching the prefix but not `<prefix><digits>$` are out
    // of scope and must be left alone.
    const name = `${PREFIX}not-a-pid`;
    const path = join(tmuxSocketDir(), name);
    writeFileSync(path, "");
    try {
      const removed = sweepOrphanTmuxSockets(PREFIX);
      assert.equal(removed, 0);
      assert.ok(existsSync(path), "non-pid suffix must be ignored");
    } finally {
      try { unlinkSync(path); } catch {}
    }
  });

  it("ignores sockets that don't match the prefix", () => {
    const deadPid = freshDeadPid();
    // Matches the `<prefix><pid>` shape but with a different prefix,
    // so the sweep should not touch it even though the pid is dead.
    const otherPrefix = "katulong-test-otherprefix-";
    const name = `${otherPrefix}${deadPid}`;
    const path = join(tmuxSocketDir(), name);
    writeFileSync(path, "");
    try {
      const removed = sweepOrphanTmuxSockets(PREFIX);
      assert.equal(removed, 0);
      assert.ok(existsSync(path), "non-matching prefix must be left alone");
    } finally {
      try { unlinkSync(path); } catch {}
    }
  });
});
