import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractFilesFromEntry,
  summarizeSession,
  parseShortLongResponse,
} from "../lib/claude-narrator.js";

describe("parseShortLongResponse", () => {
  it("splits SHORT and LONG sections", () => {
    const raw = `SHORT:
We're reworking the Claude feed to pin a running summary.

LONG:
The feed tile now gets a session summary that updates as the conversation
continues, with the short form at the top and a longer form for the tab
tooltip.`;
    const out = parseShortLongResponse(raw);
    assert.equal(out.short, "We're reworking the Claude feed to pin a running summary.");
    assert.ok(out.long.startsWith("The feed tile now gets"));
  });

  it("tolerates missing SHORT label", () => {
    const raw = `We're debugging the auth flow.

LONG:
The session is pinned on fixing a regression in session token rotation.`;
    const out = parseShortLongResponse(raw);
    assert.equal(out.short, "We're debugging the auth flow.");
    assert.ok(out.long.startsWith("The session is pinned"));
  });

  it("falls back to whole-body as both short and long when the divider is missing", () => {
    const raw = "We're just chatting.";
    const out = parseShortLongResponse(raw);
    assert.equal(out.short, "We're just chatting.");
    assert.equal(out.long, "We're just chatting.");
  });

  it("returns null for empty input", () => {
    assert.strictEqual(parseShortLongResponse(""), null);
    assert.strictEqual(parseShortLongResponse("   "), null);
  });
});

describe("summarizeSession", () => {
  it("returns null without calling Ollama when transcript is empty", async () => {
    let called = false;
    const callOllama = async () => { called = true; return "nope"; };
    assert.strictEqual(await summarizeSession({ transcript: "", callOllama }), null);
    assert.strictEqual(await summarizeSession({ transcript: "   ", callOllama }), null);
    assert.strictEqual(called, false);
  });

  it("passes previous summary + transcript into the prompt and parses the response", async () => {
    const capturedPrompts = [];
    const callOllama = async (userPrompt, { systemPrompt }) => {
      capturedPrompts.push({ userPrompt, systemPrompt });
      return `SHORT:\nWe're writing tests.\n\nLONG:\nVerifying the summarizer wiring.`;
    };
    const out = await summarizeSession({
      transcript: "User: write a test\nClaude: on it",
      previous: { short: "Earlier short", long: "Earlier long" },
      callOllama,
    });
    assert.equal(out.short, "We're writing tests.");
    assert.equal(out.long, "Verifying the summarizer wiring.");
    assert.equal(capturedPrompts.length, 1);
    assert.ok(capturedPrompts[0].userPrompt.includes("PREVIOUS SUMMARY"));
    assert.ok(capturedPrompts[0].userPrompt.includes("Earlier short"));
    assert.ok(capturedPrompts[0].userPrompt.includes("RECENT TRANSCRIPT"));
    assert.ok(capturedPrompts[0].systemPrompt.includes("summarize"));
  });

  it("omits PREVIOUS SUMMARY when there isn't one yet", async () => {
    const capturedPrompts = [];
    const callOllama = async (userPrompt) => {
      capturedPrompts.push(userPrompt);
      return "SHORT:\nFresh.\nLONG:\nNo prior state.";
    };
    await summarizeSession({ transcript: "User: hi\nClaude: hello", callOllama });
    assert.ok(!capturedPrompts[0].includes("PREVIOUS SUMMARY"));
  });

  it("throws when callOllama is not a function", async () => {
    await assert.rejects(
      () => summarizeSession({ transcript: "x", callOllama: null }),
      /callOllama is required/,
    );
  });
});

describe("extractFilesFromEntry", () => {
  it("returns [] when the entry has no tools", () => {
    assert.deepEqual(extractFilesFromEntry({ role: "assistant" }), []);
    assert.deepEqual(extractFilesFromEntry({ role: "assistant", tools: [] }), []);
    assert.deepEqual(extractFilesFromEntry(null), []);
  });

  it("pulls Read paths with offset as the line number", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "Read", input: { file_path: "/src/a.js", offset: 42 } },
        { name: "Read", input: { file_path: "/src/b.js" } },
      ],
    });
    assert.deepEqual(files, [{ path: "/src/a.js", line: 42 }, { path: "/src/b.js" }]);
  });

  it("pulls Write / Edit paths without lines", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "Write", input: { file_path: "/out.txt" } },
        { name: "Edit", input: { file_path: "/src/mod.js" } },
      ],
    });
    assert.deepEqual(files, [{ path: "/out.txt" }, { path: "/src/mod.js" }]);
  });

  it("dedupes by path — first line wins", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "Read", input: { file_path: "/src/a.js", offset: 10 } },
        { name: "Edit", input: { file_path: "/src/a.js" } },
        { name: "Read", input: { file_path: "/src/a.js", offset: 99 } },
      ],
    });
    assert.deepEqual(files, [{ path: "/src/a.js", line: 10 }]);
  });

  it("skips Grep/Glob paths containing a glob star", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "Grep", input: { path: "src/**/*.js" } },
        { name: "Glob", input: { path: "/literal/dir" } },
        { name: "Glob", input: { path: "**/*.ts" } },
      ],
    });
    assert.deepEqual(files, [{ path: "/literal/dir" }]);
  });

  it("extracts `cd <path>` from Bash commands", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "Bash", input: { command: "cd /Users/me/proj && npm test" } },
        { name: "Bash", input: { command: "ls -la" } },
      ],
    });
    assert.deepEqual(files, [{ path: "/Users/me/proj" }]);
  });

  it("ignores unknown tool names", () => {
    const files = extractFilesFromEntry({
      role: "assistant",
      tools: [
        { name: "WebFetch", input: { url: "https://example.com/a.js" } },
        { name: "SomeThingElse", input: { file_path: "/should/not/leak" } },
      ],
    });
    assert.deepEqual(files, []);
  });
});
