/**
 * Integration test for `test/helpers/setup-env.js`' socket lifecycle.
 *
 * The sweep helper has its own unit tests; this file pins the contract
 * that setup-env actually uses it. It spawns a real child `node
 * --import setup-env.js`, sandboxed to a private TMUX_TMPDIR so the
 * test can't pollute `/tmp/tmux-$UID/` (the directory this whole fix
 * exists to keep clean) and can't race other parallel test files.
 *
 * The cleanup contract under test: tmux does NOT unlink the socket on
 * `kill-server`, so every graceful exit leaves a socket behind. The
 * next test process's boot-time sweep reaps it (along with orphans
 * from any hard-killed prior runs). These tests verify that sweep
 * actually runs and is correctly scoped.
 *
 * Regressions caught here:
 *   - setup-env deletes the sweep call → orphan accumulates
 *   - sweep accidentally reaps live sockets (false positive)
 *   - sweep widens its match pattern and touches unrelated files
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const SETUP_ENV_PATH = resolve("test/helpers/setup-env.js");

function tmuxAvailable() {
  try {
    spawnSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freshDeadPid() {
  // Spawn and await a short-lived process so its PID is free afterward.
  return spawnSync("true", [], { stdio: "ignore" }).pid;
}

/**
 * Run `node --import <setup-env> -e <script>` with a sandboxed
 * TMUX_TMPDIR and return { socketDir, childSocketName, exitCode }.
 *
 * The socket dir is `<tmpdir>/tmux-<uid>` since that's where tmux
 * (and therefore our sweep) looks when TMUX_TMPDIR is honored.
 */
function runChildWithSandbox({ preseed = [], sandbox: reusedSandbox } = {}) {
  // Use /tmp directly (not os.tmpdir()) because on macOS tmpdir resolves
  // to /var/folders/... which, combined with the socket filename, blows
  // past the ~104-char unix domain socket path limit and tmux bails with
  // "File name too long" before the anchor session ever binds.
  const sandbox = reusedSandbox || mkdtempSync("/tmp/ktl-swp-");
  const socketDir = join(sandbox, `tmux-${process.getuid()}`);
  mkdirSync(socketDir, { recursive: true });
  // tmux refuses to use a socket dir unless it's 0700, regardless of
  // TMUX_TMPDIR. Without this it silently skips creating the server
  // and the sweep test has nothing to observe.
  chmodSync(socketDir, 0o700);

  for (const name of preseed) {
    // Regular files are sufficient: the sweep's PID check happens
    // before any tmux interaction, so it never cares whether the
    // entry is a real socket or not. A `kill-server` attempt on a
    // regular file fails quietly, then unlink removes the file.
    writeFileSync(join(socketDir, name), "");
  }

  // Short script: exit promptly but give setup-env time to run its
  // synchronous startup work (sweep + anchor). 50ms is generous —
  // setup-env itself is sync; the delay only protects against
  // cross-platform timing surprises from the anchor spawn.
  const script = "setTimeout(() => process.exit(0), 50)";
  const result = spawnSync(
    process.execPath,
    ["--import", SETUP_ENV_PATH, "-e", script],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMUX_TMPDIR: sandbox,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );

  // The child's socket is `katulong-test-<childpid>`.
  const childSocketName = `katulong-test-${result.pid}`;

  return {
    sandbox,
    socketDir,
    childSocketName,
    exitCode: result.status,
    stderr: result.stderr,
  };
}

function cleanup(socketDir, sandbox) {
  // Best-effort: kill any tmux servers that somehow survived, then rm
  // the sandbox. We never want this test to be the reason a socket
  // leaks into the real /tmp/tmux-$UID.
  try {
    for (const name of readdirSync(socketDir)) {
      try {
        spawnSync("tmux", ["-L", name, "kill-server"], {
          stdio: "ignore",
          env: { ...process.env, TMUX_TMPDIR: sandbox },
        });
      } catch {}
    }
  } catch {}
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
}

describe("setup-env socket lifecycle", () => {
  before(function () {
    if (!tmuxAvailable()) this.skip("tmux not installed");
  });

  it("a prior process's socket is swept by the next boot", () => {
    // First boot: child A runs setup-env, creates its own socket,
    // exits cleanly. Because `kill-server` does not unlink, the socket
    // file persists. Second boot: child B runs setup-env; its sweep
    // sees child A's PID is dead and reaps the orphan.
    const first = runChildWithSandbox();
    try {
      assert.equal(first.exitCode, 0, `childA exit=${first.exitCode}; stderr=${first.stderr}`);
      const orphanPath = join(first.socketDir, first.childSocketName);
      assert.ok(
        existsSync(orphanPath),
        "kill-server does not unlink; socket must remain after clean exit",
      );

      const second = runChildWithSandbox({ sandbox: first.sandbox });
      assert.equal(second.exitCode, 0, `childB exit=${second.exitCode}; stderr=${second.stderr}`);
      assert.equal(
        existsSync(orphanPath),
        false,
        "childB's boot-time sweep must reap childA's orphan",
      );
    } finally {
      cleanup(first.socketDir, first.sandbox);
    }
  });

  it("sweeps orphan sockets whose creator PID is dead", () => {
    const deadPid = freshDeadPid();
    const orphan = `katulong-test-${deadPid}`;
    const { sandbox, socketDir, exitCode, stderr } = runChildWithSandbox({
      preseed: [orphan],
    });
    try {
      assert.equal(exitCode, 0, `child should exit 0; stderr=${stderr}`);
      assert.equal(
        existsSync(join(socketDir, orphan)),
        false,
        "orphan socket (dead PID) must be swept at startup",
      );
    } finally {
      cleanup(socketDir, sandbox);
    }
  });

  it("leaves sockets alone whose creator PID is alive", () => {
    // Parent (this test process) is alive for the whole child run.
    const alive = `katulong-test-${process.pid}`;
    const { sandbox, socketDir, exitCode, stderr } = runChildWithSandbox({
      preseed: [alive],
    });
    try {
      assert.equal(exitCode, 0, `child should exit 0; stderr=${stderr}`);
      assert.ok(
        existsSync(join(socketDir, alive)),
        "socket whose creator is alive must not be swept",
      );
    } finally {
      cleanup(socketDir, sandbox);
    }
  });

  it("ignores entries that don't match <prefix><pid>", () => {
    // Unrelated file in the socket dir — must survive the sweep
    // regardless of who owns it.
    const unrelated = "katulong-test-not-a-pid";
    const { sandbox, socketDir, exitCode, stderr } = runChildWithSandbox({
      preseed: [unrelated],
    });
    try {
      assert.equal(exitCode, 0, `child should exit 0; stderr=${stderr}`);
      assert.ok(
        existsSync(join(socketDir, unrelated)),
        "non-matching entry must be left alone",
      );
    } finally {
      cleanup(socketDir, sandbox);
    }
  });
});
