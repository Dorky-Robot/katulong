/**
 * slugifyCwd tests — the slug rule must match Claude's observed on-disk
 * convention. The old `resolveLatestTranscript` heuristic was removed
 * (live-process inspection replaces it; see claude-feed-routes.js), so
 * this file only covers the remaining pure function.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { slugifyCwd } from "../lib/claude-transcript-discovery.js";

describe("slugifyCwd", () => {
  it("slugs a plain path", () => {
    assert.strictEqual(
      slugifyCwd("/Users/felix/Projects/dorky_robot/katulong"),
      "-Users-felix-Projects-dorky-robot-katulong",
    );
  });

  it("collapses dots to hyphens like Claude does for dotfile paths", () => {
    // Observed on disk: /path/.claude/... yields `...--claude-...`
    assert.strictEqual(
      slugifyCwd("/path/to/.claude/worktrees/foo"),
      "-path-to--claude-worktrees-foo",
    );
  });

  it("returns empty string for empty/invalid input", () => {
    assert.strictEqual(slugifyCwd(""), "");
    assert.strictEqual(slugifyCwd(null), "");
    assert.strictEqual(slugifyCwd(undefined), "");
  });

  it("is lossy by design — underscore and hyphen collide", () => {
    assert.strictEqual(slugifyCwd("/a/foo_bar"), slugifyCwd("/a/foo-bar"));
  });
});
