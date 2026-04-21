import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveFilePath,
  inferWorktreeLabel,
  __resetWorktreeCache,
} from "../lib/worktree-resolver.js";

/**
 * Build a fake stat() that resolves for the listed absolute paths and
 * rejects (ENOENT) for everything else. Matches the shape of node:fs/promises
 * stat — only the resolve/reject distinction is observed by resolveFilePath.
 */
function fakeStat(existingPaths) {
  const set = new Set(existingPaths);
  return (p) => set.has(p)
    ? Promise.resolve({ isFile: () => true })
    : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
}

function fakeGit(list) {
  return () => Promise.resolve(list);
}

describe("inferWorktreeLabel", () => {
  const MAIN = "/Users/x/proj";
  const WT = "/Users/x/proj/.claude/worktrees/feat-a";
  const WT_OTHER = "/Users/x/proj/.claude/worktrees/feat-b";
  const worktrees = [MAIN, WT, WT_OTHER];

  it("returns null for paths in the primary worktree", () => {
    assert.equal(inferWorktreeLabel(`${MAIN}/docs/a.md`, worktrees), null);
  });

  it("returns basename for paths in a sibling worktree", () => {
    assert.equal(inferWorktreeLabel(`${WT}/docs/a.md`, worktrees), "feat-a");
    assert.equal(inferWorktreeLabel(`${WT_OTHER}/x.js`, worktrees), "feat-b");
  });

  it("returns null for paths outside all worktrees", () => {
    assert.equal(inferWorktreeLabel("/tmp/foo.md", worktrees), null);
    assert.equal(inferWorktreeLabel("/Users/y/other/file.md", worktrees), null);
  });

  it("returns null for empty worktree list", () => {
    assert.equal(inferWorktreeLabel(`${MAIN}/a.md`, []), null);
  });

  it("prefers the longest matching worktree (nesting)", () => {
    // A worktree nested inside another should claim the path over its parent.
    const nested = "/a";
    const deeper = "/a/b";
    assert.equal(inferWorktreeLabel("/a/b/x.md", [nested, deeper]), "b");
  });
});

describe("resolveFilePath", () => {
  const CWD = "/Users/x/proj";
  const WT = "/Users/x/proj/.claude/worktrees/feat-a";

  beforeEach(() => __resetWorktreeCache());

  it("returns the raw path with no cwd and a relative input", async () => {
    const out = await resolveFilePath(
      { path: "docs/a.md", cwd: null },
      { stat: fakeStat([]), runGit: fakeGit([]) },
    );
    assert.deepEqual(out, { absPath: "docs/a.md", exists: false, worktreeLabel: null });
  });

  it("stats an absolute path and reports existence", async () => {
    const abs = "/etc/hosts";
    const out = await resolveFilePath(
      { path: abs, cwd: null },
      { stat: fakeStat([abs]), runGit: fakeGit([]) },
    );
    assert.equal(out.absPath, abs);
    assert.equal(out.exists, true);
    assert.equal(out.worktreeLabel, null);
  });

  it("resolves against cwd when the file lives there", async () => {
    const hit = `${CWD}/docs/a.md`;
    const out = await resolveFilePath(
      { path: "docs/a.md", cwd: CWD },
      { stat: fakeStat([hit]), runGit: fakeGit([CWD, WT]) },
    );
    assert.equal(out.absPath, hit);
    assert.equal(out.exists, true);
    assert.equal(out.worktreeLabel, null, "primary worktree gets no badge");
  });

  it("falls back to a sibling worktree when cwd misses", async () => {
    // The actual bug: Claude launched from main checkout, operates on worktree
    // via `git -C <worktree>`, prints a relative path. Naive join against cwd
    // 404s; the file lives under a sibling worktree.
    const hit = `${WT}/docs/rewrite.md`;
    const out = await resolveFilePath(
      { path: "docs/rewrite.md", cwd: CWD },
      { stat: fakeStat([hit]), runGit: fakeGit([CWD, WT]) },
    );
    assert.equal(out.absPath, hit);
    assert.equal(out.exists, true);
    assert.equal(out.worktreeLabel, "feat-a");
  });

  it("prefers the cwd worktree when the same relpath exists in siblings", async () => {
    // Both paths exist — disambiguate by checking cwd first so a user who
    // `cd`'d into a worktree doesn't get pulled into main by accident.
    const cwdHit = `${CWD}/docs/a.md`;
    const wtHit = `${WT}/docs/a.md`;
    const out = await resolveFilePath(
      { path: "docs/a.md", cwd: CWD },
      { stat: fakeStat([cwdHit, wtHit]), runGit: fakeGit([CWD, WT]) },
    );
    assert.equal(out.absPath, cwdHit);
  });

  it("returns the naive cwd-relative fallback when nothing exists", async () => {
    const out = await resolveFilePath(
      { path: "missing.md", cwd: CWD },
      { stat: fakeStat([]), runGit: fakeGit([CWD, WT]) },
    );
    assert.equal(out.absPath, `${CWD}/missing.md`);
    assert.equal(out.exists, false);
    assert.equal(out.worktreeLabel, null);
  });

  it("tags an absolute path that falls under a sibling worktree", async () => {
    // File link clicks that pass absolute paths should still surface the
    // worktree badge so users can tell which checkout the tile belongs to.
    const abs = `${WT}/notes/todo.md`;
    const out = await resolveFilePath(
      { path: abs, cwd: CWD },
      { stat: fakeStat([abs]), runGit: fakeGit([CWD, WT]) },
    );
    assert.equal(out.absPath, abs);
    assert.equal(out.worktreeLabel, "feat-a");
  });

  it("gracefully handles git failure (empty worktree list)", async () => {
    // Non-git cwd, missing git binary, timeout — the resolver returns [] and
    // falls back to cwd-only resolution, preserving pre-fix behavior.
    const hit = `${CWD}/docs/a.md`;
    const out = await resolveFilePath(
      { path: "docs/a.md", cwd: CWD },
      { stat: fakeStat([hit]), runGit: fakeGit([]) },
    );
    assert.equal(out.absPath, hit);
    assert.equal(out.worktreeLabel, null);
  });

  it("handles empty path input", async () => {
    const out = await resolveFilePath(
      { path: "", cwd: CWD },
      { stat: fakeStat([]), runGit: fakeGit([CWD]) },
    );
    assert.equal(out.exists, false);
    assert.equal(out.absPath, "");
  });
});
