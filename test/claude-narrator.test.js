import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { summarizeReply, SYSTEM_PROMPT } from "../lib/claude-narrator.js";

describe("summarizeReply", () => {
  it("returns null for empty / non-string input without calling Ollama", async () => {
    let called = false;
    const callOllama = async () => { called = true; return "nope"; };

    assert.strictEqual(await summarizeReply("", callOllama), null);
    assert.strictEqual(await summarizeReply("   ", callOllama), null);
    assert.strictEqual(await summarizeReply(null, callOllama), null);
    assert.strictEqual(await summarizeReply(undefined, callOllama), null);
    assert.strictEqual(called, false, "empty input must not trigger an Ollama call");
  });

  it("throws when callOllama is not a function", async () => {
    await assert.rejects(
      () => summarizeReply("hello", null),
      /callOllama is required/,
    );
  });

  it("returns the first-line trim of the Ollama response", async () => {
    const callOllama = async (userPrompt, opts) => {
      assert.ok(userPrompt.includes("CLAUDE REPLY"), "prompt names the input kind");
      assert.equal(opts.systemPrompt, SYSTEM_PROMPT);
      return "  Narrowing down the regex bug to a locale issue  ";
    };

    const title = await summarizeReply("some long reply text…", callOllama);
    assert.equal(title, "Narrowing down the regex bug to a locale issue");
  });

  it("discards everything after the first newline", async () => {
    const callOllama = async () => "Title line\nexplanation we don't want";
    const title = await summarizeReply("reply", callOllama);
    assert.equal(title, "Title line");
  });

  it("strips leading / trailing quote marks", async () => {
    const callOllama = async () => `"Investigating the failing auth redirect"`;
    const title = await summarizeReply("reply", callOllama);
    assert.equal(title, "Investigating the failing auth redirect");
  });

  it("strips an accidental 'Title: ' prefix", async () => {
    const callOllama = async () => "Title: Fixing the regex bug";
    const title = await summarizeReply("reply", callOllama);
    assert.equal(title, "Fixing the regex bug");
  });

  it("returns null when the model response is whitespace-only", async () => {
    const callOllama = async () => "   \n\n  ";
    assert.strictEqual(await summarizeReply("reply", callOllama), null);
  });

  it("returns null when callOllama returns a non-string", async () => {
    const callOllama = async () => ({ err: "nope" });
    assert.strictEqual(await summarizeReply("reply", callOllama), null);
  });

  it("caps the title at MAX_TITLE_CHARS with an ellipsis", async () => {
    const long = "x".repeat(500);
    const callOllama = async () => long;
    const title = await summarizeReply("reply", callOllama);
    assert.ok(title.length <= 140, `expected ≤ 140 chars, got ${title.length}`);
    assert.ok(title.endsWith("…"));
  });

  it("propagates Ollama errors (caller decides retry/skip)", async () => {
    const callOllama = async () => { throw new Error("connection refused"); };
    await assert.rejects(
      () => summarizeReply("reply", callOllama),
      /connection refused/,
    );
  });
});
