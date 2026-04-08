/**
 * Test environment setup — loaded via --import before any test modules.
 *
 * Each test file runs in its own Node process (node:test's default
 * parallelism spawns a subprocess per file), and this module runs once
 * per process. That makes it the right place to set up per-process
 * isolation for anything that would otherwise cross-contaminate between
 * parallel test files.
 *
 * Two isolations are set up here:
 *
 * 1. **KATULONG_DATA_DIR** — each test process gets its own temp data dir
 *    so parallel auth tests don't stomp on each other's ~/.katulong/
 *    (which may be owned by root in CI/containers).
 *
 * 2. **KATULONG_TMUX_SOCKET** — each test process gets its own isolated
 *    tmux server, scoped by PID. Without this, every integration test
 *    that spawns a real server ends up talking to the developer's
 *    DEFAULT tmux socket, which (a) leaks sessions into the developer's
 *    real tmux for tmux-continuum to snapshot-and-restore forever, and
 *    (b) causes flaky cross-file races — e.g. `sessions-crud` and
 *    `credential-revoke` both creating sessions on the same shared
 *    socket while they run in parallel.
 *
 *    See `lib/tmux.js:tmuxSocketArgs()` for the `-L <name>` wiring this
 *    hooks into. The socket name MUST match `/^[A-Za-z0-9_-]+$/`;
 *    `katulong-test-<pid>` satisfies that.
 *
 * Both are cleaned up on process exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

if (!process.env.KATULONG_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "katulong-test-"));
  process.env.KATULONG_DATA_DIR = dir;

  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

if (!process.env.KATULONG_TMUX_SOCKET) {
  // PID-scoped socket so parallel test files can't collide, and each
  // test file starts with a fresh (empty) tmux server.
  const socketName = `katulong-test-${process.pid}`;
  process.env.KATULONG_TMUX_SOCKET = socketName;

  // Create a detached "anchor" session to keep the tmux server alive
  // for the duration of the test file. Without this, the tmux server
  // exits as soon as the last test session is deleted — and the next
  // POST /sessions races the re-spawn and fails with "server exited
  // unexpectedly". The anchor holds the server open until our exit
  // handler runs `kill-server`.
  //
  // `tmux start-server` alone is not enough: tmux considers a server
  // with zero sessions idle and will exit it shortly after. Only an
  // actual session keeps the server running indefinitely.
  //
  // Best-effort: if tmux isn't installed (unit tests that mock tmux
  // entirely) this fails and we continue. Those tests never talk to
  // the real tmux binary anyway.
  try {
    execFileSync(
      "tmux",
      ["-L", socketName, "new-session", "-d", "-s", "__katulong_test_anchor__"],
      { stdio: "ignore" },
    );
  } catch {
    // tmux not available or already has this session — ignore
  }

  process.on("exit", () => {
    // Tear down the entire tmux server on our socket. This wipes every
    // session this test file created (plus the anchor) in one shot —
    // much faster and more reliable than enumerating known session
    // names and killing them individually. If tmux never started a
    // server on this socket (e.g. a unit test that mocked tmux
    // entirely), the command fails and we ignore it.
    try {
      execFileSync("tmux", ["-L", socketName, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // no tmux server on this socket — nothing to clean up
    }
  });
}
