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
 * Socket cleanup: `kill-server` stops the tmux anchor on graceful exit,
 * but tmux does not unlink the socket file on `kill-server` — so every
 * exit leaves an orphan behind. Rather than fight this at each
 * kill-server call site, we rely on a single sweep-at-boot: the next
 * test process that starts picks up its predecessors' orphans and
 * reaps them (see `tmux-socket-sweep.js`). This also handles the
 * SIGKILL / CI-timeout case where `kill-server` never ran at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sweepOrphanTmuxSockets } from "../../lib/tmux-socket-sweep.js";

// Marks the process as a test run — production modules can gate
// mutating test-only exports on this (see lib/routes/auth-routes.js
// `_resetMintForTesting` / `_expireMintForTesting`).
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

if (!process.env.KATULONG_DATA_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "katulong-test-"));
  process.env.KATULONG_DATA_DIR = dir;

  process.on("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

if (!process.env.KATULONG_TMUX_SOCKET) {
  // Reap orphan sockets from prior test runs. Catches both
  //   (a) graceful exits where `kill-server` ran but did not unlink, and
  //   (b) hard kills (SIGKILL / CI or pre-push hook timeouts / OOM)
  //       where the exit handler never ran at all.
  // Without this, `/tmp/tmux-$UID/` accumulates `katulong-test-*` socket
  // files indefinitely and eventually destabilizes tmux itself.
  sweepOrphanTmuxSockets("katulong-test-");

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
    // Stop the tmux server so the anchor process does not outlive the
    // test run. The socket file itself is intentionally not unlinked
    // here — tmux does not unlink on `kill-server` and we rely on the
    // next test process's boot-time sweep to reap it. See module
    // header for the rationale.
    try {
      execFileSync("tmux", ["-L", socketName, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // no tmux server on this socket — nothing to clean up
    }
  });
}
