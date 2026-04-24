import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGitInfo } from "../lib/git-info.js";

function fakeRunner(responses) {
  // responses keyed by the first meaningful arg, in order of `rev-parse`:
  // we just return the same canned output for any matching cwd.
  return async (cwd, args) => {
    if (args[0] !== "rev-parse") return null;
    const canned = responses[cwd];
    if (canned === undefined) return null;
    return canned;
  };
}

describe("getGitInfo", () => {
  it("returns null for non-absolute cwd", async () => {
    assert.equal(await getGitInfo("relative/path"), null);
    assert.equal(await getGitInfo(""), null);
    assert.equal(await getGitInfo(null), null);
    assert.equal(await getGitInfo(undefined), null);
  });

  it("returns null when git fails", async () => {
    const runGit = async () => null;
    assert.equal(await getGitInfo("/Users/x/proj", { runGit }), null);
  });

  it("parses a plain repo (no linked worktree)", async () => {
    const runGit = fakeRunner({
      "/Users/x/proj": "/Users/x/proj\nmain\n/Users/x/proj/.git\n",
    });
    const info = await getGitInfo("/Users/x/proj", { runGit });
    assert.deepEqual(info, { project: "proj", branch: "main", worktree: null });
  });

  it("returns null branch when HEAD is detached", async () => {
    const runGit = fakeRunner({
      "/Users/x/proj": "/Users/x/proj\nHEAD\n/Users/x/proj/.git\n",
    });
    const info = await getGitInfo("/Users/x/proj", { runGit });
    assert.deepEqual(info, { project: "proj", branch: null, worktree: null });
  });

  it("identifies linked worktrees via --git-common-dir", async () => {
    // cwd is `/Users/x/proj-wt/feat`, common dir is the main checkout's .git
    const runGit = fakeRunner({
      "/Users/x/proj-wt/feat": "/Users/x/proj-wt/feat\nfeat-branch\n/Users/x/proj/.git\n",
    });
    const info = await getGitInfo("/Users/x/proj-wt/feat", { runGit });
    assert.deepEqual(info, {
      project: "proj",      // from common dir's parent
      branch: "feat-branch",
      worktree: "feat",     // from --show-toplevel
    });
  });

  it("handles relative --git-common-dir output", async () => {
    // Plain repo: git returns `.git` relative to cwd.
    const runGit = fakeRunner({
      "/Users/x/proj": "/Users/x/proj\nmain\n.git\n",
    });
    const info = await getGitInfo("/Users/x/proj", { runGit });
    assert.deepEqual(info, { project: "proj", branch: "main", worktree: null });
  });

  it("returns null when output is truncated", async () => {
    const runGit = fakeRunner({ "/Users/x/proj": "/Users/x/proj\n" });
    assert.equal(await getGitInfo("/Users/x/proj", { runGit }), null);
  });

  it("returns null when toplevel is not absolute", async () => {
    const runGit = fakeRunner({
      "/Users/x/proj": "not-absolute\nmain\n/foo/.git\n",
    });
    assert.equal(await getGitInfo("/Users/x/proj", { runGit }), null);
  });
});
