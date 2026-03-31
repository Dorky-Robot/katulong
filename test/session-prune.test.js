/**
 * Tests for `katulong session prune` subcommand.
 *
 * Mocks the API client to verify that prune correctly identifies orphaned
 * auto-generated sessions (session-XXXX pattern, alive, no child processes)
 * and kills them via DELETE /sessions/:name.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// --- Mock the API client before importing the command ---

const apiClientUrl = new URL("../lib/cli/api-client.js", import.meta.url).href;

let mockSessions = [];
let deletedSessions = [];

mock.module(apiClientUrl, {
  namedExports: {
    ensureRunning: () => {},
    api: {
      get: async (path) => {
        if (path === "/sessions") return mockSessions;
        throw new Error(`Unexpected GET ${path}`);
      },
      del: async (path) => {
        const match = path.match(/^\/sessions\/(.+)$/);
        if (match) {
          deletedSessions.push(decodeURIComponent(match[1]));
          return { ok: true, action: "deleted" };
        }
        throw new Error(`Unexpected DELETE ${path}`);
      },
    },
  },
});

const { default: sessionCommand } = await import("../lib/cli/commands/session.js");

// Helper: capture stdout
async function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  console.log = (...args) => { chunks.push(args.join(" ") + "\n"); };
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return chunks.join("");
}

// Helper: capture stderr
async function captureStderr(fn) {
  const chunks = [];
  const origError = console.error;
  console.error = (...args) => { chunks.push(args.join(" ") + "\n"); };
  try {
    await fn();
  } finally {
    console.error = origError;
  }
  return chunks.join("");
}

describe("katulong session prune", () => {
  beforeEach(() => {
    deletedSessions = [];
    mockSessions = [];
  });

  it("prunes auto-generated sessions that are alive with no child processes", async () => {
    mockSessions = [
      { name: "session-m4x7k9p", alive: true, hasChildProcesses: false },
      { name: "session-abc123", alive: true, hasChildProcesses: false },
      { name: "my-custom-session", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune"]));

    assert.deepStrictEqual(deletedSessions, ["session-m4x7k9p", "session-abc123"]);
    assert.ok(output.includes("Pruned 2 session(s)"), `Expected pruned count in: ${output}`);
  });

  it("skips sessions with child processes", async () => {
    mockSessions = [
      { name: "session-aaa111", alive: true, hasChildProcesses: true },
      { name: "session-bbb222", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune"]));

    assert.deepStrictEqual(deletedSessions, ["session-bbb222"]);
    assert.ok(output.includes("Pruned 1 session(s)"), `Expected pruned count in: ${output}`);
  });

  it("skips dead sessions", async () => {
    mockSessions = [
      { name: "session-dead1", alive: false, hasChildProcesses: false },
      { name: "session-live1", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune"]));

    assert.deepStrictEqual(deletedSessions, ["session-live1"]);
  });

  it("skips sessions that don't match auto-generated pattern", async () => {
    mockSessions = [
      { name: "dev-server", alive: true, hasChildProcesses: false },
      { name: "my session", alive: true, hasChildProcesses: false },
      { name: "Session-ABC", alive: true, hasChildProcesses: false }, // uppercase
      { name: "session-", alive: true, hasChildProcesses: false },    // no suffix
    ];

    const output = await captureStdout(() => sessionCommand(["prune"]));

    assert.deepStrictEqual(deletedSessions, []);
    assert.ok(output.includes("No orphaned sessions"), `Expected no-op message in: ${output}`);
  });

  it("reports nothing to prune when no sessions exist", async () => {
    mockSessions = [];

    const output = await captureStdout(() => sessionCommand(["prune"]));

    assert.deepStrictEqual(deletedSessions, []);
    assert.ok(output.includes("No orphaned sessions"), `Expected no-op message in: ${output}`);
  });

  it("supports --json output", async () => {
    mockSessions = [
      { name: "session-j1", alive: true, hasChildProcesses: false },
      { name: "session-j2", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune", "--json"]));
    const data = JSON.parse(output.trim());

    assert.strictEqual(data.pruned, 2);
    assert.deepStrictEqual(data.sessions, ["session-j1", "session-j2"]);
  });

  it("supports --json output when nothing to prune", async () => {
    mockSessions = [];

    const output = await captureStdout(() => sessionCommand(["prune", "--json"]));
    const data = JSON.parse(output.trim());

    assert.strictEqual(data.pruned, 0);
    assert.deepStrictEqual(data.sessions, []);
  });

  it("supports --dry-run to preview without killing", async () => {
    mockSessions = [
      { name: "session-dry1", alive: true, hasChildProcesses: false },
      { name: "session-dry2", alive: true, hasChildProcesses: false },
      { name: "my-named-session", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune", "--dry-run"]));

    assert.deepStrictEqual(deletedSessions, [], "dry-run should not delete anything");
    assert.ok(output.includes("Would prune 2"), `Expected preview in: ${output}`);
    assert.ok(output.includes("session-dry1"), `Expected session name in: ${output}`);
    assert.ok(output.includes("session-dry2"), `Expected session name in: ${output}`);
  });

  it("supports --dry-run with --json", async () => {
    mockSessions = [
      { name: "session-dryjson", alive: true, hasChildProcesses: false },
    ];

    const output = await captureStdout(() => sessionCommand(["prune", "--dry-run", "--json"]));
    const data = JSON.parse(output.trim());

    assert.strictEqual(data.wouldPrune, 1);
    assert.deepStrictEqual(data.sessions, ["session-dryjson"]);
    assert.deepStrictEqual(deletedSessions, [], "dry-run should not delete anything");
  });

  it("correctly matches the auto-generated name pattern", () => {
    // The regex exported behavior — test via the filter logic
    const autoNameRe = /^session-[0-9a-z]+$/;

    // Should match: base-36 encoded timestamps
    assert.ok(autoNameRe.test("session-m4x7k9p"));
    assert.ok(autoNameRe.test("session-abc123"));
    assert.ok(autoNameRe.test("session-0"));
    assert.ok(autoNameRe.test("session-zzzzzzz"));

    // Should NOT match
    assert.ok(!autoNameRe.test("session-"));          // no suffix
    assert.ok(!autoNameRe.test("session-ABC"));        // uppercase
    assert.ok(!autoNameRe.test("Session-abc"));        // uppercase prefix
    assert.ok(!autoNameRe.test("dev-server"));         // different prefix
    assert.ok(!autoNameRe.test("session-abc def"));    // space
    assert.ok(!autoNameRe.test("session-abc_def"));    // underscore
    assert.ok(!autoNameRe.test("my session"));         // no prefix
  });
});
