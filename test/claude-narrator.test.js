import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractFilesFromEntry } from "../lib/claude-narrator.js";

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
