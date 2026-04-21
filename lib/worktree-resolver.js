/**
 * Worktree-aware file path resolver.
 *
 * When Claude (or the shell) prints a relative path like `docs/foo.md`, the
 * naive resolution is `join(session.cwd, relpath)`. That falls apart when the
 * session's cwd is in one directory but the agent is actually operating on a
 * sibling git worktree — e.g. `cd main && claude` but then
 * `git -C .claude/worktrees/feature/ ...` or `claude --add-dir ...`. The
 * per-pid `~/.claude/sessions/<pid>.json` only captures Claude's launch cwd,
 * and the tmux pane's cwd doesn't drift with in-process `/cd` either (see
 * `docs/file-link-worktree-resolution.md`).
 *
 * Rather than trying to predict where Claude "thinks" it's working, we let
 * the filesystem answer: if the file isn't at `<cwd>/<relpath>`, try the
 * same relpath under every sibling worktree that `git worktree list` knows
 * about and return the first hit. This is the "no worktree-aware search
 * fallback" non-goal from the doc, reconsidered — it only fires when the
 * cwd-relative path doesn't exist, so there's no ambiguity to mediate in
 * the common case. If the same relpath happens to exist in several
 * worktrees, we prefer the cwd worktree first, then the order git reports
 * (main worktree first).
 *
 * The resolver also returns a `worktreeLabel` string — the basename of the
 * matching worktree when it isn't the primary one — so tiles can surface a
 * small badge like `rewrite-rust-leptos` next to the filename. That turns
 * an implicit resolution into a visible one: you can tell at a glance that
 * the open file is from a sibling worktree, not the main checkout, without
 * having to eyeball the absolute path.
 *
 * Never throws. A non-git cwd, a missing `git` binary, or a permission
 * error on `stat` all collapse to the naive `join(cwd, relpath)` with
 * `exists:false`, preserving the previous behavior.
 */

import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";

const WORKTREE_CACHE_MS = 5000;
const worktreeCache = new Map();

function runGitWorktreeList(cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "worktree", "list", "--porcelain"],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || typeof stdout !== "string") return resolve([]);
        const paths = [];
        for (const line of stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            paths.push(line.slice("worktree ".length).trim());
          }
        }
        resolve(paths);
      },
    );
  });
}

async function listWorktrees(cwd, opts = {}) {
  const runner = opts.runGit || runGitWorktreeList;
  const now = Date.now();
  const cached = worktreeCache.get(cwd);
  if (cached && now - cached.at < WORKTREE_CACHE_MS) return cached.paths;
  const paths = await runner(cwd);
  worktreeCache.set(cwd, { paths, at: now });
  return paths;
}

/** Test-only: drop the worktree list cache. */
export function __resetWorktreeCache() {
  worktreeCache.clear();
}

/**
 * Return the display label for the worktree that contains `absPath`, or
 * `null` if the path falls under the primary worktree (first entry from
 * `git worktree list`, which is always the main checkout) or outside all
 * known worktrees. Longest match wins when worktrees nest, which matters
 * if someone points `.claude/worktrees/` at a sibling repo.
 */
export function inferWorktreeLabel(absPath, worktrees) {
  if (typeof absPath !== "string" || !Array.isArray(worktrees) || worktrees.length === 0) {
    return null;
  }
  const primary = worktrees[0];
  const sorted = [...worktrees].sort((a, b) => b.length - a.length);
  for (const wt of sorted) {
    const prefix = wt.endsWith("/") ? wt : wt + "/";
    if (absPath === wt || absPath.startsWith(prefix)) {
      if (wt === primary) return null;
      return basename(wt);
    }
  }
  return null;
}

/**
 * Resolve a (possibly relative) path against a session's cwd, falling back
 * to sibling git worktrees when the naive resolution misses.
 *
 * @param {{ path: string, cwd?: string | null }} args
 * @param {{ stat?: Function, runGit?: Function }} [opts] test seams
 * @returns {Promise<{absPath: string, exists: boolean, worktreeLabel: string | null}>}
 */
export async function resolveFilePath({ path, cwd }, opts = {}) {
  const statFn = opts.stat || stat;

  if (typeof path !== "string" || path.length === 0) {
    return { absPath: "", exists: false, worktreeLabel: null };
  }

  const hasCwd = typeof cwd === "string" && cwd.startsWith("/");
  const worktrees = hasCwd ? await listWorktrees(cwd, opts) : [];

  if (path.startsWith("/")) {
    const exists = await statFn(path).then(() => true, () => false);
    return {
      absPath: path,
      exists,
      worktreeLabel: inferWorktreeLabel(path, worktrees),
    };
  }

  if (!hasCwd) {
    return { absPath: path, exists: false, worktreeLabel: null };
  }

  const candidates = [cwd];
  for (const wt of worktrees) {
    if (!candidates.includes(wt)) candidates.push(wt);
  }

  for (const base of candidates) {
    const abs = join(base, path);
    const ok = await statFn(abs).then(() => true, () => false);
    if (ok) {
      return {
        absPath: abs,
        exists: true,
        worktreeLabel: inferWorktreeLabel(abs, worktrees),
      };
    }
  }

  const fallback = join(cwd, path);
  return {
    absPath: fallback,
    exists: false,
    worktreeLabel: inferWorktreeLabel(fallback, worktrees),
  };
}
