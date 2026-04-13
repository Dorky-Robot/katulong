import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transformClaudeEvent } from "../lib/claude-event-transform.js";

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
      hook_event_name: "PreToolUse",
    });

    assert.equal(result.message.step, "PreToolUse");
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
