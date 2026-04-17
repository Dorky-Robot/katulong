/**
 * Claude Narrator Tests
 *
 * The narrator is a pure-ish transform: transcript slice + rolling summary
 * goes in, events come out. Ollama is injected as a function so we don't
 * need the network in unit tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  narrateSlice,
  buildStopCard,
  buildPreToolUseCard,
  hasRealWork,
  extractFiles,
  detectAttention,
  parseResponse,
  buildPrompt,
  updateSummary,
} from "../lib/claude-narrator.js";

function fakeOllama(response) {
  return async () => response;
}

describe("hasRealWork", () => {
  it("is false for empty slices", () => {
    assert.strictEqual(hasRealWork([]), false);
  });

  it("is false when there's only empty metadata", () => {
    assert.strictEqual(hasRealWork([{ role: "user", text: "" }]), false);
    assert.strictEqual(hasRealWork([{ role: "assistant" }]), false);
  });

  it("is true when there's a non-empty user prompt", () => {
    assert.strictEqual(hasRealWork([{ role: "user", text: "fix the bug" }]), true);
  });

  it("is true when the assistant has text or tools", () => {
    assert.strictEqual(hasRealWork([{ role: "assistant", text: "ok" }]), true);
    assert.strictEqual(
      hasRealWork([{ role: "assistant", tools: [{ name: "Read" }] }]),
      true,
    );
  });
});

describe("extractFiles", () => {
  it("collects paths from Read / Write / Edit", () => {
    const entries = [{
      role: "assistant",
      tools: [
        { name: "Read", input: { file_path: "/a/foo.js", offset: 10 } },
        { name: "Edit", input: { file_path: "/a/bar.js" } },
        { name: "Write", input: { file_path: "/a/baz.js" } },
      ],
    }];
    const files = extractFiles(entries);
    assert.deepStrictEqual(files, [
      { path: "/a/foo.js", line: 10 },
      { path: "/a/bar.js" },
      { path: "/a/baz.js" },
    ]);
  });

  it("pulls cd targets out of Bash commands", () => {
    const entries = [{
      role: "assistant",
      tools: [{ name: "Bash", input: { command: "cd /tmp/work && ls" } }],
    }];
    assert.deepStrictEqual(extractFiles(entries), [{ path: "/tmp/work" }]);
  });

  it("ignores glob paths and unknown tools", () => {
    const entries = [{
      role: "assistant",
      tools: [
        { name: "Grep", input: { path: "src/**/*.js", pattern: "x" } },
        { name: "FakeToolCall", input: { file_path: "/should/not/appear.js" } },
      ],
    }];
    assert.deepStrictEqual(extractFiles(entries), []);
  });

  it("deduplicates repeated paths", () => {
    const entries = [
      { role: "assistant", tools: [{ name: "Read", input: { file_path: "/a.js", offset: 5 } }] },
      { role: "assistant", tools: [{ name: "Read", input: { file_path: "/a.js", offset: 50 } }] },
    ];
    assert.deepStrictEqual(extractFiles(entries), [{ path: "/a.js", line: 5 }]);
  });
});

describe("detectAttention", () => {
  it("flags question marks at the end of the last line", () => {
    assert.strictEqual(detectAttention("Here's a summary\n\nShould I continue?"), true);
  });

  it("flags question phrases", () => {
    assert.strictEqual(detectAttention("I can do A, B, or C. Which would you prefer"), true);
  });

  it("does not flag numbered lists without a question", () => {
    assert.strictEqual(
      detectAttention("Done. I made these changes:\n1. Added X\n2. Fixed Y"),
      false,
    );
  });

  it("returns false on empty input", () => {
    assert.strictEqual(detectAttention(""), false);
    assert.strictEqual(detectAttention(null), false);
  });
});

describe("parseResponse", () => {
  it("splits OBJECTIVE + narrative on the --- divider", () => {
    const text = "OBJECTIVE: Build a feed\n---\nWe start by sketching the data model.";
    const { objective, narrative } = parseResponse(text);
    assert.strictEqual(objective, "Build a feed");
    assert.strictEqual(narrative, "We start by sketching the data model.");
  });

  it("treats a response without a divider as all-narrative", () => {
    const text = "Just a narrative chunk with no header.";
    const { objective, narrative } = parseResponse(text);
    assert.strictEqual(objective, null);
    assert.strictEqual(narrative, text);
  });

  it("returns narrative = null when the bottom is empty", () => {
    const text = "OBJECTIVE: Only a header\n---\n";
    const { objective, narrative } = parseResponse(text);
    assert.strictEqual(objective, "Only a header");
    assert.strictEqual(narrative, null);
  });
});

describe("buildPrompt", () => {
  it("prepends the rolling summary when present", () => {
    const prompt = buildPrompt([{ role: "user", text: "hi" }], "Previously…");
    assert.ok(prompt.includes("NARRATIVE SO FAR:"));
    assert.ok(prompt.includes("Previously…"));
    assert.ok(prompt.includes("TRANSCRIPT SLICE:"));
  });

  it("omits the summary section when empty", () => {
    const prompt = buildPrompt([{ role: "user", text: "hi" }], "");
    assert.ok(!prompt.includes("NARRATIVE SO FAR:"));
    assert.ok(prompt.includes("TRANSCRIPT SLICE:"));
  });
});

describe("updateSummary", () => {
  it("concatenates on first call", () => {
    assert.strictEqual(updateSummary("", "hello"), "hello");
  });

  it("joins with a blank line between chunks", () => {
    assert.strictEqual(updateSummary("a", "b"), "a\n\nb");
  });

  it("truncates from the front when over the cap", () => {
    const big = "x".repeat(2100);
    const result = updateSummary(big, "new");
    assert.ok(result.length <= 2000);
    assert.ok(result.endsWith("new"));
  });
});

describe("buildStopCard", () => {
  it("returns null for empty text", () => {
    assert.strictEqual(buildStopCard(""), null);
    assert.strictEqual(buildStopCard(null), null);
  });

  it("returns a completion card for normal messages", () => {
    const card = buildStopCard("All done — PR is ready.");
    assert.strictEqual(card.status, "completion");
    assert.strictEqual(card.event, "Completion");
    assert.strictEqual(card.step, "All done — PR is ready.");
  });

  it("returns an attention card when the message asks a question", () => {
    const card = buildStopCard("I can fix it in two ways. Which would you prefer?");
    assert.strictEqual(card.status, "attention");
    assert.strictEqual(card.event, "Attention");
  });

  it("truncates long completion messages", () => {
    const text = "x".repeat(600);
    const card = buildStopCard(text);
    assert.ok(card.step.length <= 500);
    assert.ok(card.step.endsWith("…"));
  });
});

describe("buildPreToolUseCard", () => {
  it("returns an attention card naming the tool", () => {
    const card = buildPreToolUseCard({ toolName: "Bash", target: "rm -rf tmp" });
    assert.strictEqual(card.status, "attention");
    assert.strictEqual(card.tool, "Bash");
    assert.ok(card.step.includes("Bash"));
    assert.ok(card.step.includes("rm -rf tmp"));
  });

  it("returns null without a tool name", () => {
    assert.strictEqual(buildPreToolUseCard({}), null);
  });

  it("falls back to tool name when no target given", () => {
    const card = buildPreToolUseCard({ toolName: "Write" });
    assert.ok(card.step.includes("Write"));
  });
});

describe("narrateSlice", () => {
  const entries = [
    { role: "user", text: "fix the login bug" },
    { role: "assistant", text: "ok", tools: [{ name: "Read", input: { file_path: "/a.js" } }] },
  ];

  it("requires callOllama", async () => {
    await assert.rejects(
      () => narrateSlice({ entries, callOllama: null }),
      /callOllama is required/,
    );
  });

  it("returns empty when entries are empty", async () => {
    const result = await narrateSlice({ entries: [], callOllama: fakeOllama("won't be called") });
    assert.deepStrictEqual(result.events, []);
    assert.strictEqual(result.summary, "");
  });

  it("returns empty when the slice has no real work", async () => {
    const result = await narrateSlice({
      entries: [{ role: "user", text: "" }],
      callOllama: fakeOllama("should not run"),
    });
    assert.deepStrictEqual(result.events, []);
  });

  it("returns empty when Ollama returns an empty body", async () => {
    const result = await narrateSlice({ entries, callOllama: fakeOllama("   ") });
    assert.deepStrictEqual(result.events, []);
  });

  it("emits a narrative event and updates summary", async () => {
    const response = "OBJECTIVE: Fix login\n---\nInvestigating the login flow by reading `a.js`.";
    const result = await narrateSlice({ entries, summary: "", callOllama: fakeOllama(response) });
    assert.strictEqual(result.events.length, 2);
    assert.strictEqual(result.events[0].status, "narrative");
    assert.strictEqual(result.events[0].files.length, 1);
    assert.strictEqual(result.events[1].status, "summary");
    assert.strictEqual(result.events[1].step, "Fix login");
    assert.strictEqual(result.objective, "Fix login");
    assert.ok(result.summary.includes("Investigating"));
  });

  it("does not re-emit the objective when it hasn't changed", async () => {
    const response = "OBJECTIVE: Fix login\n---\nMore investigation…";
    const result = await narrateSlice({
      entries,
      summary: "",
      objective: "Fix login",
      callOllama: fakeOllama(response),
    });
    // Expect only the narrative event; no re-published summary.
    const statuses = result.events.map(e => e.status);
    assert.deepStrictEqual(statuses, ["narrative"]);
    assert.strictEqual(result.objective, "Fix login");
  });

  it("propagates call signature to callOllama (system prompt + user prompt)", async () => {
    let captured = null;
    const spy = async (userPrompt, opts) => {
      captured = { userPrompt, opts };
      return "OBJECTIVE: x\n---\nY";
    };
    await narrateSlice({ entries, callOllama: spy });
    assert.ok(captured.userPrompt.includes("TRANSCRIPT SLICE:"));
    assert.ok(typeof captured.opts.systemPrompt === "string");
    assert.ok(captured.opts.systemPrompt.length > 0);
  });

  it("surfaces Ollama errors to the caller", async () => {
    const boom = async () => { throw new Error("ollama down"); };
    await assert.rejects(
      () => narrateSlice({ entries, callOllama: boom }),
      /ollama down/,
    );
  });
});
