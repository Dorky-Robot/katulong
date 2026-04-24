/**
 * Git-info probe for a session's shell cwd.
 *
 * Derives a compact `{ project, branch, worktree }` triple from a path,
 * using a single `git rev-parse` invocation. Never throws — a non-git
 * cwd, a missing `git` binary, or any failure resolves to `null` so the
 * pane monitor never crashes on a transient hiccup.
 *
 * Fields:
 *   - project   basename of `--show-toplevel` (the repo root of the
 *               primary worktree OR of the worktree itself — see below)
 *   - branch    `--abbrev-ref HEAD`, or `null` when HEAD is detached
 *   - worktree  basename of the current worktree when it differs from
 *               the primary checkout, else `null`. We derive this by
 *               asking `rev-parse` for both `--show-toplevel` (the
 *               current worktree root) and `--path-format=absolute
 *               --git-common-dir` (shared across linked worktrees). When
 *               the current cwd is a linked worktree, `--show-toplevel`
 *               is the worktree dir and the project name is inferred
 *               from the common-dir's grandparent (e.g.
 *               `/repo/.git/worktrees/feat` → project `repo`,
 *               worktree `feat`).
 *
 * Kept in its own module so the pane-monitor reconciler can import it
 * without pulling in the whole `worktree-resolver` (which has a
 * different concern — resolving relative paths, not describing the
 * repo).
 */

import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

const DEFAULT_TIMEOUT_MS = 2000;

function defaultRunGit(cwd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: timeoutMs },
      (err, stdout) => {
        if (err || typeof stdout !== "string") return resolve(null);
        resolve(stdout);
      },
    );
  });
}

/**
 * Probe git metadata for `cwd`. Returns `null` when the cwd is not a
 * git repo or when the probe fails for any reason.
 *
 * @param {string} cwd  absolute path
 * @param {{runGit?: (cwd: string, args: string[], timeoutMs: number) => Promise<string|null>, timeoutMs?: number}} [opts]
 * @returns {Promise<{project: string, branch: string|null, worktree: string|null}|null>}
 */
export async function getGitInfo(cwd, opts = {}) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return null;
  const runGit = opts.runGit || defaultRunGit;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Single call, multiple outputs. Newline-separated in the order
  // arguments are given. `--` terminates option parsing so a pathological
  // cwd name can't be interpreted as a flag.
  const out = await runGit(
    cwd,
    ["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD", "--git-common-dir"],
    timeoutMs,
  );
  if (!out) return null;

  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const [topLevel, branchRaw, commonDirRaw] = lines;

  if (!topLevel || !topLevel.startsWith("/")) return null;

  const branch = branchRaw === "HEAD" ? null : (branchRaw || null);

  // `--git-common-dir` is relative to cwd when it's under cwd (bare
  // ".git") but can be absolute for linked worktrees. Normalize to an
  // absolute path so the worktree check below works either way.
  let commonDir = commonDirRaw || null;
  if (commonDir && !commonDir.startsWith("/")) {
    commonDir = `${cwd.replace(/\/$/, "")}/${commonDir}`;
  }

  // If we're inside a linked worktree, --show-toplevel points at the
  // worktree directory, not the primary checkout. The primary checkout
  // is the parent of the common git dir (e.g. `/repo/.git` → `/repo`).
  // When common dir is a worktrees/<name> entry, dirname twice gets us
  // back to the primary `.git`, but the canonical way is to rely on
  // common dir ending with `.git` for a standard repo layout.
  let project = basename(topLevel);
  let worktree = null;

  if (commonDir) {
    const commonParent = dirname(commonDir); // parent of `.git`
    // `.git` lives at the primary checkout root. If that's different
    // from our topLevel we're in a linked worktree.
    if (basename(commonDir) === ".git" && commonParent !== topLevel) {
      project = basename(commonParent);
      worktree = basename(topLevel);
    }
  }

  return { project, branch, worktree };
}
