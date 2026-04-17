/**
 * Transcript Discovery Tests
 *
 * Covers the cwd→UUID resolver:
 *   - slug rule matches Claude's observed on-disk convention
 *   - returns null cleanly when nothing matches
 *   - picks the newest-modified .jsonl
 *   - respects the maxAgeMs window for "recent only"
 *   - ignores non-jsonl files and non-UUID filenames
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  slugifyCwd,
  projectDirFor,
  resolveLatestTranscript,
  isClaudeUuid,
} from "../lib/claude-transcript-discovery.js";

const UUID_A = "ff16582e-bbb4-49c6-90cf-e731be656442";
const UUID_B = "01234567-89ab-cdef-0123-456789abcdef";
const UUID_C = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function touch(path, mtimeMsAgo) {
  writeFileSync(path, "");
  if (mtimeMsAgo !== undefined) {
    const t = new Date(Date.now() - mtimeMsAgo);
    utimesSync(path, t, t);
  }
}

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

describe("isClaudeUuid", () => {
  it("accepts canonical v4 form", () => {
    assert.strictEqual(isClaudeUuid(UUID_A), true);
  });
  it("rejects garbage", () => {
    assert.strictEqual(isClaudeUuid("not-a-uuid"), false);
    assert.strictEqual(isClaudeUuid(""), false);
    assert.strictEqual(isClaudeUuid(null), false);
    assert.strictEqual(isClaudeUuid(UUID_A + ".jsonl"), false);
  });
});

describe("projectDirFor", () => {
  it("composes the expected path", () => {
    const p = projectDirFor("/Users/a/foo", { home: "/home" });
    assert.strictEqual(p, "/home/.claude/projects/-Users-a-foo");
  });

  it("returns null when cwd is empty", () => {
    assert.strictEqual(projectDirFor("", { home: "/home" }), null);
  });
});

describe("resolveLatestTranscript", () => {
  let home;
  let cwd;
  let projectDir;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "katulong-discovery-home-"));
    cwd = "/Users/test/proj";
    projectDir = join(home, ".claude", "projects", slugifyCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when the project dir doesn't exist", () => {
    const result = resolveLatestTranscript({ cwd: "/does/not/exist", home });
    assert.strictEqual(result, null);
  });

  it("returns null when the project dir is empty", () => {
    const result = resolveLatestTranscript({ cwd, home });
    assert.strictEqual(result, null);
  });

  it("returns the only .jsonl when there's just one", () => {
    touch(join(projectDir, `${UUID_A}.jsonl`));
    const result = resolveLatestTranscript({ cwd, home });
    assert.ok(result);
    assert.strictEqual(result.uuid, UUID_A);
    assert.strictEqual(result.transcriptPath, join(projectDir, `${UUID_A}.jsonl`));
  });

  it("picks the newest-modified .jsonl when there are multiple", () => {
    touch(join(projectDir, `${UUID_A}.jsonl`), 60_000); // 1 min ago
    touch(join(projectDir, `${UUID_B}.jsonl`), 10_000); // 10s ago (newest)
    touch(join(projectDir, `${UUID_C}.jsonl`), 120_000); // 2 min ago
    const result = resolveLatestTranscript({ cwd, home });
    assert.strictEqual(result.uuid, UUID_B);
  });

  it("respects maxAgeMs — drops files older than the window", () => {
    touch(join(projectDir, `${UUID_A}.jsonl`), 60_000); // 60s ago
    touch(join(projectDir, `${UUID_B}.jsonl`), 600_000); // 10 min ago
    // 2-minute window → A qualifies, B does not
    const result = resolveLatestTranscript({ cwd, home, maxAgeMs: 120_000 });
    assert.strictEqual(result.uuid, UUID_A);
  });

  it("returns null when all files are beyond maxAgeMs", () => {
    touch(join(projectDir, `${UUID_A}.jsonl`), 600_000); // 10 min ago
    const result = resolveLatestTranscript({ cwd, home, maxAgeMs: 60_000 });
    assert.strictEqual(result, null);
  });

  it("ignores non-.jsonl files", () => {
    touch(join(projectDir, `${UUID_A}.jsonl`));
    touch(join(projectDir, "NOT_A_TRANSCRIPT.txt"));
    touch(join(projectDir, "random-file"));
    const result = resolveLatestTranscript({ cwd, home });
    assert.strictEqual(result.uuid, UUID_A);
  });

  it("ignores .jsonl files whose stem is not a UUID", () => {
    touch(join(projectDir, "not-a-uuid.jsonl"));
    touch(join(projectDir, `${UUID_A}.jsonl`));
    const result = resolveLatestTranscript({ cwd, home });
    assert.strictEqual(result.uuid, UUID_A);
  });

  it("ignores directories that happen to end in .jsonl", () => {
    mkdirSync(join(projectDir, "fake.jsonl"));
    touch(join(projectDir, `${UUID_A}.jsonl`));
    const result = resolveLatestTranscript({ cwd, home });
    assert.strictEqual(result.uuid, UUID_A);
  });
});
