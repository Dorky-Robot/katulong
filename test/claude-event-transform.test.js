import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformClaudeEvent, readTranscriptEntries } from "../lib/claude-event-transform.js";

describe("transformClaudeEvent", () => {
  const SESSION_ID = "6bc4b919-90f6-484d-937d-d78e11aa1aa2";

  it("returns null for missing payload", () => {
    assert.equal(transformClaudeEvent(null), null);
    assert.equal(transformClaudeEvent(undefined), null);
    assert.equal(transformClaudeEvent("string"), null);
  });

  it("returns null when session_id is missing", () => {
    assert.equal(transformClaudeEvent({ hook_event_name: "Stop" }), null);
  });

  it("returns null when hook_event_name is missing", () => {
    assert.equal(transformClaudeEvent({ session_id: SESSION_ID }), null);
  });

  it("returns null for non-UUID session_id", () => {
    assert.equal(transformClaudeEvent({ session_id: "../evil", hook_event_name: "Stop" }), null);
    assert.equal(transformClaudeEvent({ session_id: "not-a-uuid", hook_event_name: "Stop" }), null);
    assert.equal(transformClaudeEvent({ session_id: 12345, hook_event_name: "Stop" }), null);
  });

  it("transforms PostToolUse with file-based tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/src/lib/app.js", old_string: "a", new_string: "b" },
      tool_response: "Successfully edited file",
    });

    assert.equal(result.topic, `claude/${SESSION_ID}`);
    assert.equal(result.message.step, "Edit app.js");
    assert.equal(result.message.status, "done");
    assert.equal(result.message.detail, "Successfully edited file");
    assert.equal(result.message.event, "PostToolUse");
    assert.equal(result.message.tool, "Edit");
  });

  it("transforms PostToolUse with Bash tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "All tests passed",
    });

    assert.equal(result.message.step, "Bash npm test");
    assert.equal(result.message.status, "done");
  });

  it("truncates long Bash commands", () => {
    const longCmd = "find /very/long/path -name '*.js' -exec grep -l 'pattern' {} + | sort | head -50";
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: longCmd },
    });

    assert.ok(result.message.step.length <= 45); // "Bash " + 40 chars max
    assert.ok(result.message.step.endsWith("\u2026"));
  });

  it("transforms PostToolUse with Grep tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "function\\s+\\w+" },
    });

    assert.equal(result.message.step, "Grep function\\s+\\w+");
  });

  it("transforms PostToolUse with Glob tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Glob",
      tool_input: { pattern: "**/*.test.js" },
    });

    assert.equal(result.message.step, "Glob **/*.test.js");
  });

  it("transforms PostToolUse with Agent tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "Search for auth patterns" },
    });

    assert.equal(result.message.step, "Agent Search for auth patterns");
  });

  it("transforms PostToolUse with unknown tool", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "CustomTool",
      tool_input: { foo: "bar" },
    });

    assert.equal(result.message.step, "CustomTool");
  });

  it("transforms UserPromptSubmit", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "UserPromptSubmit",
      prompt: "read package.json",
    });

    assert.equal(result.message.step, "User: read package.json");
    assert.equal(result.message.status, "active");
  });

  it("truncates long user prompts", () => {
    const longPrompt = "please refactor this entire codebase to use TypeScript with strict mode and add comprehensive test coverage for every module";
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "UserPromptSubmit",
      prompt: longPrompt,
    });

    assert.ok(result.message.step.length <= 67); // "User: " + 60 chars + ellipsis
  });

  it("transforms Stop event", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "Stop",
      last_assistant_message: "I've made the changes you requested.",
    });

    assert.equal(result.message.step, "Claude responded");
    assert.equal(result.message.status, "done");
    assert.equal(result.message.detail, "I've made the changes you requested.");
  });

  it("handles Stop with no message", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "Stop",
    });

    assert.equal(result.message.detail, "");
  });

  it("transforms SubagentStart", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "SubagentStart",
      description: "Explore codebase structure",
      agent_type: "Explore",
    });

    assert.equal(result.message.step, "Subagent: Explore codebase structure");
    assert.equal(result.message.status, "active");
    assert.equal(result.message.detail, "Explore");
  });

  it("transforms SubagentStop (keyed update of SubagentStart)", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "SubagentStop",
      description: "Explore codebase structure",
    });

    assert.equal(result.message.step, "Subagent: Explore codebase structure");
    assert.equal(result.message.status, "done");
  });

  it("transforms SessionStart", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "SessionStart",
      cwd: "/Users/dev/project",
    });

    assert.equal(result.message.step, "Session started");
    assert.equal(result.message.status, "info");
    assert.equal(result.message.detail, "/Users/dev/project");
  });

  it("transforms SessionEnd", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "SessionEnd",
    });

    assert.equal(result.message.step, "Session ended");
    assert.equal(result.message.status, "info");
  });

  it("handles unknown event types as generic log entries", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "SomeFutureHookEvent",
    });

    assert.equal(result.message.step, "SomeFutureHookEvent");
    assert.equal(result.message.status, "info");
  });

  it("truncates long detail to first line", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/src/app.js" },
      tool_response: "Line 1 of content\nLine 2\nLine 3\nLine 4",
    });

    assert.equal(result.message.detail, "Line 1 of content");
  });

  it("handles missing tool_input gracefully", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
    });

    assert.equal(result.message.step, "Edit");
    assert.equal(result.message.status, "done");
  });

  it("extracts stdout from structured Bash tool_response", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "All 42 tests passed", stderr: "", interrupted: false },
    });

    assert.equal(result.message.detail, "All 42 tests passed");
  });

  it("falls back to stderr if stdout is empty", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bad-cmd" },
      tool_response: { stdout: "", stderr: "command not found: bad-cmd" },
    });

    assert.equal(result.message.detail, "command not found: bad-cmd");
  });

  it("handles missing tool_response gracefully", () => {
    const result = transformClaudeEvent({
      session_id: SESSION_ID,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });

    assert.equal(result.message.detail, "");
  });
});

describe("readTranscriptEntries", () => {
  let tmpDir;
  before(() => { tmpDir = mkdtempSync(join(tmpdir(), "transcript-test-")); });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  // Inject the minimum fields every real transcript entry has (uuid +
  // timestamp) unless the test already sets them. Keeps fixtures focused on
  // the content shape without every line restating bookkeeping.
  let _fakeUuidCtr = 0;
  let _fakeTsCtr = 0;
  function withDefaults(entry) {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return entry;
    const patched = { ...entry };
    if (patched.uuid === undefined && patched.type !== "summary") {
      // Fixed base so tests can compare entry uuids when they care; each
      // writeTranscript() call starts the counter fresh.
      patched.uuid = `00000000-0000-4000-8000-${String(_fakeUuidCtr++).padStart(12, "0")}`;
    }
    if (patched.timestamp === undefined && patched.type !== "summary") {
      patched.timestamp = new Date(1_700_000_000_000 + 1000 * _fakeTsCtr++).toISOString();
    }
    return patched;
  }

  function writeTranscript(name, lines) {
    _fakeUuidCtr = 0;
    _fakeTsCtr = 0;
    const path = join(tmpDir, name);
    const patched = lines.map(withDefaults);
    writeFileSync(path, patched.map(l => typeof l === "string" ? l : JSON.stringify(l)).join("\n"));
    return path;
  }

  it("returns empty result for missing path", () => {
    const result = readTranscriptEntries(null);
    assert.deepEqual(result, { entries: [], nextCursor: 0, hasMore: false });
  });

  it("returns empty result when file does not exist", () => {
    const result = readTranscriptEntries(join(tmpDir, "does-not-exist.jsonl"));
    assert.deepEqual(result, { entries: [], nextCursor: 0, hasMore: false });
  });

  it("normalizes an assistant text + tool_use turn into one entry", () => {
    const path = writeTranscript("assistant.jsonl", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Looking at the auth module." },
            { type: "tool_use", id: "toolu_01ABC", name: "Read", input: { file_path: "/src/auth.js", offset: 42 } },
          ],
        },
      },
    ]);
    const { entries, nextCursor } = readTranscriptEntries(path);
    assert.equal(nextCursor, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "assistant");
    assert.equal(entries[0].text, "Looking at the auth module.");
    assert.deepEqual(entries[0].tools, [
      { id: "toolu_01ABC", name: "Read", input: { file_path: "/src/auth.js", offset: 42 } },
    ]);
  });

  it("preserves tool_use.id and correlates tool_result.tool_use_id", () => {
    // The frontend keys tool cards on toolUseId to flip running→ok/error
    // when the matching result lands. A transform that drops either id
    // side breaks that correlation silently (cards stuck mid-animation).
    const path = writeTranscript("pair.jsonl", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01AAA", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01AAA", content: "total 8\ndrwx...", is_error: false },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_01BBB", content: "command failed", is_error: true },
          ],
        },
      },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].tools[0].id, "toolu_01AAA");
    assert.equal(entries[1].role, "tool_result");
    assert.deepEqual(entries[1].results, [
      { toolUseId: "toolu_01AAA", text: "total 8\ndrwx...", isError: false },
    ]);
    assert.equal(entries[2].results[0].toolUseId, "toolu_01BBB");
    assert.equal(entries[2].results[0].isError, true);
  });

  it("keeps tool_result full output on results[] even when text is truncated", () => {
    // The narrator's `text` field is capped at 500 chars so the
    // summarizer doesn't eat a whole bash log, but the feed card's
    // expand body needs the full output. `results[].text` must carry
    // the untruncated content per block.
    const big = "x".repeat(2000);
    const path = writeTranscript("big.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01X", content: big }],
        },
      },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].text.length <= 500, "narrator text is capped");
    assert.equal(entries[0].results[0].text.length, 2000, "per-result text is full");
    assert.equal(entries[0].results[0].isError, false);
  });

  it("normalizes a user string-content entry", () => {
    const path = writeTranscript("user.jsonl", [
      { type: "user", message: { role: "user", content: "Fix the login bug." } },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[0].text, "Fix the login bug.");
    assert.ok(typeof entries[0].uuid === "string" && entries[0].uuid);
    assert.ok(Number.isFinite(entries[0].ts));
  });

  it("distinguishes user text from tool_result user entries", () => {
    const path = writeTranscript("mixed.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Please fix it." }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "exit status 0" }] } },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[1].role, "tool_result");
    assert.equal(entries[1].text, "exit status 0");
  });

  it("skips metadata entries with no message", () => {
    const path = writeTranscript("meta.jsonl", [
      { type: "summary", operation: "compact", timestamp: "t", sessionId: "s", content: "summary text" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ]);
    const { entries, nextCursor } = readTranscriptEntries(path);
    assert.equal(nextCursor, 2, "cursor advances past skipped lines");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "hi");
  });

  it("advances cursor past blank trailing lines", () => {
    const path = writeTranscript("trailing.jsonl", [
      { type: "user", message: { role: "user", content: "a" } },
      "",
      "",
    ]);
    const { nextCursor } = readTranscriptEntries(path);
    assert.equal(nextCursor, 1);
  });

  it("returns only the slice after fromLine", () => {
    const path = writeTranscript("slice.jsonl", [
      { type: "user", message: { role: "user", content: "first" } },
      { type: "user", message: { role: "user", content: "second" } },
      { type: "user", message: { role: "user", content: "third" } },
    ]);
    const { entries, nextCursor } = readTranscriptEntries(path, 1);
    assert.equal(nextCursor, 3);
    assert.deepEqual(entries.map(e => e.text), ["second", "third"]);
  });

  it("returns empty entries when cursor is already at end", () => {
    const path = writeTranscript("end.jsonl", [
      { type: "user", message: { role: "user", content: "only" } },
    ]);
    const { entries, nextCursor } = readTranscriptEntries(path, 5);
    assert.deepEqual(entries, []);
    assert.equal(nextCursor, 1);
  });

  it("skips malformed JSON lines without throwing", () => {
    const path = writeTranscript("bad.jsonl", [
      "not json",
      { type: "user", message: { role: "user", content: "ok" } },
    ]);
    const { entries, nextCursor } = readTranscriptEntries(path);
    assert.equal(nextCursor, 2);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "ok");
  });

  it("truncates long assistant text", () => {
    const longText = "x".repeat(2000);
    const path = writeTranscript("long.jsonl", [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: longText }] } },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.ok(entries[0].text.length <= 1000);
    assert.ok(entries[0].text.endsWith("\u2026"));
  });

  it("does NOT truncate long user prompts", () => {
    // Conversation-compaction summaries get replayed as one huge user
    // message — the feed tile needs to render them in full or the
    // reader sees "Key Tech…" with no way to recover the rest.
    const longText = "x".repeat(50_000);
    const stringPath = writeTranscript("user-long-string.jsonl", [
      { type: "user", message: { role: "user", content: longText } },
    ]);
    const blockPath = writeTranscript("user-long-block.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: longText }] } },
    ]);
    const fromString = readTranscriptEntries(stringPath).entries;
    const fromBlock = readTranscriptEntries(blockPath).entries;
    assert.equal(fromString[0].text.length, 50_000);
    assert.equal(fromBlock[0].text.length, 50_000);
    assert.ok(!fromString[0].text.endsWith("\u2026"));
    assert.ok(!fromBlock[0].text.endsWith("\u2026"));
  });

  it("skips assistant entries with only thinking blocks", () => {
    const path = writeTranscript("think.jsonl", [
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "deep thoughts" }] } },
    ]);
    const { entries } = readTranscriptEntries(path);
    assert.equal(entries.length, 0);
  });

  it("respects `limit` and reports hasMore when stopped short", () => {
    const path = writeTranscript("paged.jsonl", [
      { type: "user", message: { role: "user", content: "one" } },
      { type: "user", message: { role: "user", content: "two" } },
      { type: "user", message: { role: "user", content: "three" } },
      { type: "user", message: { role: "user", content: "four" } },
    ]);
    const page1 = readTranscriptEntries(path, 0, 2);
    assert.equal(page1.entries.length, 2);
    assert.equal(page1.nextCursor, 2);
    assert.equal(page1.hasMore, true);
    assert.deepEqual(page1.entries.map(e => e.text), ["one", "two"]);

    const page2 = readTranscriptEntries(path, page1.nextCursor, 2);
    assert.equal(page2.entries.length, 2);
    assert.equal(page2.nextCursor, 4);
    assert.equal(page2.hasMore, false);
    assert.deepEqual(page2.entries.map(e => e.text), ["three", "four"]);
  });

  it("`hasMore: false` when the limit exactly hits EOF", () => {
    const path = writeTranscript("exact.jsonl", [
      { type: "user", message: { role: "user", content: "a" } },
      { type: "user", message: { role: "user", content: "b" } },
    ]);
    const result = readTranscriptEntries(path, 0, 2);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, 2);
  });
});
