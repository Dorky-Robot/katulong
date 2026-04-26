/**
 * Regression test for the orphan-smoke-test bug fixed in PR #655.
 *
 * `_finish-upgrade.js` spawns a smoke-test server on a temp port. Before
 * the fix it used `detached: true`, which puts the child in its own
 * process group — when the orchestrator received SIGHUP from an ssh
 * disconnect (or SIGINT from ^C), the child was NOT in the foreground
 * pgrp and survived as an orphan, holding the ephemeral port and
 * occasionally serving stale state.
 *
 * The fix: keep the child in the parent's pgrp by NOT detaching. Then
 * a terminal-disconnect SIGHUP propagates to the whole pgrp and the
 * child dies with the orchestrator — for free, via OS primitives.
 *
 * This test guards against accidental re-introduction of `detached: true`
 * on the smoke-test spawn. We don't try to exercise the SIGHUP path at
 * runtime — that would be testing kernel/Node behavior, not our code.
 * The thing that can actually regress is the spawn options literal.
 */

import { test } from "node:test";
import { ok } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(
  __dirname,
  "..",
  "lib",
  "cli",
  "commands",
  "_finish-upgrade.js",
);

test("smoke-test spawn must not use detached:true (orphan-on-SIGHUP regression)", () => {
  const src = readFileSync(SOURCE_PATH, "utf-8");

  // The smoke-test child is the FIRST `spawn(process.execPath` call in
  // the file. The second one (production server post-swap) is allowed
  // and required to be `detached: true` — it must outlive its parent.
  const firstSpawnIdx = src.indexOf("spawn(process.execPath");
  ok(
    firstSpawnIdx !== -1,
    "expected spawn(process.execPath, ...) call in _finish-upgrade.js",
  );
  const blockEnd = src.indexOf("});", firstSpawnIdx);
  ok(
    blockEnd > firstSpawnIdx,
    "could not locate end of smoke-test spawn options block",
  );
  const block = src.slice(firstSpawnIdx, blockEnd);

  ok(
    !/\bdetached\s*:\s*true\b/.test(block),
    "smoke-test spawn must not set detached:true — it puts the child in its own " +
      "process group and orphans it on ssh-drop SIGHUP. See PR #655.",
  );
});
