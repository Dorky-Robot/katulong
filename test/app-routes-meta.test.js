import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { publicMeta, PRIVATE_META_KEYS } from "../lib/routes/app-routes.js";

describe("publicMeta", () => {
  it("strips known private keys", () => {
    const out = publicMeta({
      type: "progress",
      cwd: "/Users/x/project",
      transcriptPath: "/Users/x/.claude/projects/y/abc.jsonl",
    });
    assert.deepEqual(out, { type: "progress", cwd: "/Users/x/project" });
  });

  it("is a no-op when no private keys are present", () => {
    const in_ = { type: "log", label: "CI" };
    const out = publicMeta(in_);
    assert.deepEqual(out, in_);
    assert.notEqual(out, in_, "returns a fresh object, not the input");
  });

  it("returns non-object inputs unchanged", () => {
    assert.equal(publicMeta(null), null);
    assert.equal(publicMeta(undefined), undefined);
    assert.equal(publicMeta("string"), "string");
  });

  it("PRIVATE_META_KEYS lists transcriptPath", () => {
    // If this ever fails the filter has drifted — anyone adding a new
    // server-only field should update both the set and the broadcast
    // paths (see ensureTopicMeta / /api/topics / POST meta).
    assert.ok(PRIVATE_META_KEYS.has("transcriptPath"));
  });
});
