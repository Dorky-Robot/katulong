/**
 * Tests for `resolveFilePathForTile` — the shared `/api/resolve-file`
 * call used by both document/image tile open paths (terminal file-link
 * clicks in app.js and file-browser row clicks in the file-browser
 * renderer). The helper is a thin wrapper: URL building + response
 * normalization. These tests cover the contract both callers depend on
 * so either can move without the other regressing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveFilePathForTile } from "../public/lib/tiles/resolve-file-for-tile.js";

/** Record every `get` call and return whatever the caller specified. */
function fakeApi(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    get(url) {
      calls.push(url);
      if (queue.length === 0) {
        throw new Error(`fakeApi: unexpected GET ${url}`);
      }
      const next = queue.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

describe("resolveFilePathForTile", () => {
  it("hits /api/resolve-file with path + session query params", async () => {
    const api = fakeApi([{ absPath: "/abs/foo.md", exists: true, worktreeLabel: null }]);
    const out = await resolveFilePathForTile(api, "docs/foo.md", "sess1");

    assert.equal(api.calls.length, 1);
    assert.equal(
      api.calls[0],
      "/api/resolve-file?path=docs%2Ffoo.md&session=sess1",
    );
    assert.deepEqual(out, { resolvedPath: "/abs/foo.md", worktreeLabel: null });
  });

  it("omits the session query param when sessionName is missing", async () => {
    const api = fakeApi([{ absPath: "/abs/bar.md", worktreeLabel: null }]);
    await resolveFilePathForTile(api, "bar.md", null);
    assert.equal(api.calls[0], "/api/resolve-file?path=bar.md");
  });

  it("threads worktreeLabel through when the resolver returns one", async () => {
    // The actual motivation for this helper: a file-browser click on a
    // .md that lives in a sibling worktree needs to surface the badge.
    const api = fakeApi([{
      absPath: "/root/.claude/worktrees/feat-a/docs/plan.md",
      exists: true,
      worktreeLabel: "feat-a",
    }]);
    const out = await resolveFilePathForTile(
      api,
      "/root/.claude/worktrees/feat-a/docs/plan.md",
      "sess",
    );
    assert.equal(out.resolvedPath, "/root/.claude/worktrees/feat-a/docs/plan.md");
    assert.equal(out.worktreeLabel, "feat-a");
  });

  it("falls back to the raw filePath when the response has no absPath", async () => {
    // The server only returns `{absPath: ""}` for empty input, but we
    // still want to behave sanely if the shape drifts — never hand a
    // falsy filePath to the tile.
    const api = fakeApi([{ absPath: "", worktreeLabel: null }]);
    const out = await resolveFilePathForTile(api, "something.md", null);
    assert.equal(out.resolvedPath, "something.md");
    assert.equal(out.worktreeLabel, null);
  });

  it("propagates rejections so callers can apply their own fallback", async () => {
    // openFileInDocTile (app.js) does a cwd-relative join on network
    // failure; the file-browser renderer skips the fallback because its
    // paths are absolute. Keeping the reject contract lets each caller
    // diverge without pushing a strategy parameter into the helper.
    const api = fakeApi([new Error("offline")]);
    await assert.rejects(
      resolveFilePathForTile(api, "docs/foo.md", "sess"),
      /offline/,
    );
  });

  it("short-circuits on empty filePath without calling the resolver", async () => {
    const api = fakeApi([]);
    const out = await resolveFilePathForTile(api, "", "sess");
    assert.equal(api.calls.length, 0);
    assert.deepEqual(out, { resolvedPath: "", worktreeLabel: null });
  });

  it("treats non-string filePath defensively", async () => {
    const api = fakeApi([]);
    const out = await resolveFilePathForTile(api, null, "sess");
    assert.equal(api.calls.length, 0);
    assert.equal(out.worktreeLabel, null);
  });
});
