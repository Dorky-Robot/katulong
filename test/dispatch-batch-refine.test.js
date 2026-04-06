/**
 * Tests for the headless batch refine engine.
 *
 * Mocks the `claude` subprocess at the spawn level so tests don't
 * actually call claude. Verifies state transitions, sourceIds mapping,
 * progress bullet deduplication, and failure revert behavior.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createDispatchStore } from "../lib/dispatch-store.js";

// ── Mock child_process.spawn before importing dispatch-refine ──────

let spawnHandler = null; // set per-test to control mock behavior

mock.module("node:child_process", {
  namedExports: {
    spawn: (cmd, args, opts) => {
      if (spawnHandler) return spawnHandler(cmd, args, opts);
      // Default: immediate exit with empty output
      const child = new EventEmitter();
      child.stdout = new Readable({ read() { this.push(null); } });
      child.stderr = new Readable({ read() { this.push(null); } });
      child.kill = () => {};
      process.nextTick(() => child.emit("close", 1));
      return child;
    },
    // Keep execFile available for other code paths
    execFile: (cmd, args, opts, cb) => {
      if (typeof opts === "function") { cb = opts; opts = {}; }
      if (cb) cb(null, "", "");
    },
  },
});

// Now import the module under test (uses mocked spawn)
const { createRefiner, toolUseBullet, buildBatchPrompt, parseResult } = await import("../lib/dispatch-refine.js");

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Create a fake claude subprocess that emits stream-json events
 * and exits with code 0.
 */
function fakeClaudeProcess(events, exitCode = 0) {
  return () => {
    const child = new EventEmitter();
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() { this.push(null); } });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};

    // Emit events on next tick so caller can set up listeners
    process.nextTick(() => {
      for (const event of events) {
        stdout.push(JSON.stringify(event) + "\n");
      }
      stdout.push(null); // end of stream
      child.emit("close", exitCode);
    });

    return child;
  };
}

/**
 * Build stream-json events simulating Claude using tools then returning a
 * result. Mirrors the real `claude -p --output-format stream-json --verbose`
 * output: tool_use blocks live inside assistant message content, not at the
 * top level. Verified by running the CLI against a fresh kubo.
 */
function assistantToolUse(name, input) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  };
}

function buildStreamEvents(tickets) {
  return [
    assistantToolUse("Bash", { command: "diwa ls" }),
    assistantToolUse("Bash", { command: 'diwa search katulong "some query"' }),
    assistantToolUse("Read", { file_path: "/work/katulong/CLAUDE.md" }),
    assistantToolUse("Grep", { pattern: "something" }),
    { type: "result", result: JSON.stringify(tickets) },
  ];
}

// ── Pure function tests ────────────────────────────────────────────

describe("toolUseBullet", () => {
  it("translates diwa ls to Listing projects", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Bash", tool_input: { command: "diwa ls" } }),
      "Listing projects"
    );
  });

  it("translates diwa search to Searching diwa history", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Bash", tool_input: { command: 'diwa search katulong "vim"' } }),
      "Searching diwa history"
    );
  });

  it("translates CLAUDE.md read to project-specific bullet", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Read", tool_input: { file_path: "/work/katulong/CLAUDE.md" } }),
      "Reading katulong CLAUDE.md"
    );
  });

  it("translates generic Read to basename", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Read", tool_input: { file_path: "/work/katulong/lib/foo.js" } }),
      "Reading foo.js"
    );
  });

  it("translates Grep/Glob to Searching codebase", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Grep", tool_input: {} }),
      "Searching codebase"
    );
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Glob", tool_input: {} }),
      "Searching codebase"
    );
  });

  it("returns null for unknown tools", () => {
    assert.equal(toolUseBullet({ type: "tool_use", tool: "Unknown", tool_input: {} }), null);
  });

  it("returns null for generic Bash commands", () => {
    assert.equal(
      toolUseBullet({ type: "tool_use", tool: "Bash", tool_input: { command: "ls -la" } }),
      null
    );
  });

  it("handles the real stream-json content-block shape (name/input)", () => {
    // This is the shape that actually arrives in production — a tool_use
    // content block nested inside assistant.message.content, which uses
    // `name` and `input` rather than `tool` and `tool_input`.
    assert.equal(
      toolUseBullet({ type: "tool_use", name: "Bash", input: { command: "diwa ls" } }),
      "Listing projects"
    );
    assert.equal(
      toolUseBullet({ type: "tool_use", name: "Read", input: { file_path: "/work/yelo/CLAUDE.md" } }),
      "Reading yelo CLAUDE.md"
    );
  });
});

describe("buildBatchPrompt", () => {
  it("includes all feature IDs in numbered list", () => {
    const features = [
      { id: "f-aaa", body: "add vim bindings" },
      { id: "f-bbb", body: "dark mode" },
    ];
    const prompt = buildBatchPrompt(features);
    assert.ok(prompt.includes("[f-aaa]"));
    assert.ok(prompt.includes("[f-bbb]"));
    assert.ok(prompt.includes("1. [f-aaa]"));
    assert.ok(prompt.includes("2. [f-bbb]"));
  });

  it("includes diwa instructions", () => {
    const prompt = buildBatchPrompt([{ id: "f-x", body: "test" }]);
    assert.ok(prompt.includes("diwa ls"));
    assert.ok(prompt.includes("diwa search"));
  });
});

describe("parseResult", () => {
  it("parses raw JSON array", () => {
    const input = '[{"title":"T","spec":"S","sourceIds":["f-1"]}]';
    const result = parseResult(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "T");
  });

  it("strips markdown fences", () => {
    const input = '```json\n[{"title":"T","spec":"S","sourceIds":["f-1"]}]\n```';
    const result = parseResult(input);
    assert.equal(result[0].title, "T");
  });

  it("handles leading text before array", () => {
    const input = 'Here is the result:\n[{"title":"T","spec":"S","sourceIds":["f-1"]}]';
    const result = parseResult(input);
    assert.equal(result[0].title, "T");
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseResult("not json at all"), /Unexpected token/);
  });
});

// ── Integration tests: refineBatch ─────────────────────────────────

describe("refineBatch", () => {
  let testDir;
  let store;
  let refiner;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-batch-refine-test-"));
    store = createDispatchStore(testDir);
    refiner = createRefiner();
  });

  afterEach(() => {
    spawnHandler = null;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("refines 2 raw features into grouped + refined state", async () => {
    const f1 = store.addFeature("add vim keybindings @katulong");
    const f2 = store.addFeature("dark mode @yelo");

    const tickets = [
      {
        title: "Add configurable key bindings",
        spec: "Implement vim-style key binding system",
        project: "katulong",
        sourceIds: [f1.id],
        status: "refined",
        subtasks: [{ id: "st-1", description: "Key binding parser", worktree: true }],
        estimatedAgents: 1,
      },
      {
        title: "Add dark mode support",
        spec: "Implement dark/light theme toggle",
        project: "yelo",
        sourceIds: [f2.id],
        status: "refined",
        subtasks: [{ id: "st-1", description: "Theme system", worktree: true }],
        estimatedAgents: 1,
      },
    ];

    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));
    const created = await refiner.refineBatch(store, [f1.id, f2.id]);

    // Should create 2 refined features
    assert.equal(created.length, 2);

    // Source features should be grouped
    const updated1 = store.getFeature(f1.id);
    const updated2 = store.getFeature(f2.id);
    assert.equal(updated1.status, "grouped");
    assert.equal(updated2.status, "grouped");
    assert.ok(updated1.groupedInto);
    assert.equal(updated1.groupedInto, updated2.groupedInto);

    // Refined features should have correct sourceIds
    const refined1 = created.find((f) => f.project === "katulong");
    const refined2 = created.find((f) => f.project === "yelo");
    assert.ok(refined1);
    assert.ok(refined2);
    assert.deepEqual(refined1.sourceIds, [f1.id]);
    assert.deepEqual(refined2.sourceIds, [f2.id]);
  });

  it("sourceIds correctly reference originals when consolidating", async () => {
    const f1 = store.addFeature("vim keys");
    const f2 = store.addFeature("keyboard shortcuts");
    const f3 = store.addFeature("dark mode");

    const tickets = [
      {
        title: "Configurable key bindings",
        spec: "Consolidates vim keys and keyboard shortcuts",
        project: "katulong",
        sourceIds: [f1.id, f2.id], // consolidated
        status: "refined",
        subtasks: [],
        estimatedAgents: 1,
      },
      {
        title: "Dark mode",
        spec: "Add theme toggle",
        project: "yelo",
        sourceIds: [f3.id],
        status: "refined",
        subtasks: [],
        estimatedAgents: 1,
      },
    ];

    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));
    const created = await refiner.refineBatch(store, [f1.id, f2.id, f3.id]);

    assert.equal(created.length, 2);
    const consolidated = created.find((f) => f.sourceIds.length === 2);
    assert.ok(consolidated);
    assert.deepEqual(consolidated.sourceIds.sort(), [f1.id, f2.id].sort());
  });

  it("appends progress bullets to grouped features from tool_use events", async () => {
    const f1 = store.addFeature("feature one");
    const f2 = store.addFeature("feature two");

    const tickets = [
      { title: "T1", spec: "S1", project: "p", sourceIds: [f1.id], status: "refined", subtasks: [], estimatedAgents: 1 },
      { title: "T2", spec: "S2", project: "p", sourceIds: [f2.id], status: "refined", subtasks: [], estimatedAgents: 1 },
    ];

    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));
    await refiner.refineBatch(store, [f1.id, f2.id]);

    // Check that log bullets were appended to the features' bodies
    const body1 = store.getFeature(f1.id).body;
    assert.ok(body1.includes("Listing projects"), `Expected "Listing projects" in body: ${body1}`);
    assert.ok(body1.includes("Searching diwa history"));
    assert.ok(body1.includes("Reading katulong CLAUDE.md"));
    assert.ok(body1.includes("Searching codebase"));
  });

  it("deduplicates consecutive identical bullets", async () => {
    const f1 = store.addFeature("test dedupe");

    const events = [
      assistantToolUse("Grep", {}),
      assistantToolUse("Grep", {}),
      assistantToolUse("Grep", {}),
      { type: "result", result: JSON.stringify([
        { title: "T", spec: "S", project: "p", sourceIds: [f1.id], status: "refined", subtasks: [], estimatedAgents: 1 },
      ]) },
    ];

    spawnHandler = fakeClaudeProcess(events);
    await refiner.refineBatch(store, [f1.id]);

    const body = store.getFeature(f1.id).body;
    const matches = body.match(/Searching codebase/g);
    assert.equal(matches.length, 1, "Should have exactly 1 'Searching codebase' bullet (deduped)");
  });

  it("invokes onProgress for each translated bullet, deduped across the batch", async () => {
    const f1 = store.addFeature("one");
    const f2 = store.addFeature("two");

    const tickets = [
      { title: "T1", spec: "S1", project: "p", sourceIds: [f1.id], status: "refined", subtasks: [], estimatedAgents: 1 },
      { title: "T2", spec: "S2", project: "p", sourceIds: [f2.id], status: "refined", subtasks: [], estimatedAgents: 1 },
    ];

    const events = [
      assistantToolUse("Bash", { command: "diwa ls" }),
      assistantToolUse("Bash", { command: "diwa ls" }),            // dupe — suppressed
      assistantToolUse("Bash", { command: 'diwa search katulong "x"' }),
      assistantToolUse("Read", { file_path: "/work/katulong/CLAUDE.md" }),
      assistantToolUse("Grep", { pattern: "foo" }),
      { type: "result", result: JSON.stringify(tickets) },
    ];

    const received = [];
    spawnHandler = fakeClaudeProcess(events);
    await refiner.refineBatch(store, [f1.id, f2.id], {
      onProgress: (bullet) => received.push(bullet),
    });

    assert.deepEqual(received, [
      "Listing projects",
      "Searching diwa history",
      "Reading katulong CLAUDE.md",
      "Searching codebase",
    ]);
  });

  it("swallows onProgress listener errors so they don't break the refine", async () => {
    const f1 = store.addFeature("robust");
    const tickets = [
      { title: "T", spec: "S", project: "p", sourceIds: [f1.id], status: "refined", subtasks: [], estimatedAgents: 1 },
    ];
    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));

    // A listener that throws on the first call should not tear down the
    // subprocess or abort the refine — the refiner must log and continue.
    let calls = 0;
    const created = await refiner.refineBatch(store, [f1.id], {
      onProgress: () => { calls++; throw new Error("boom"); },
    });

    assert.ok(calls >= 1, "Listener should still be invoked");
    assert.equal(created.length, 1);
    assert.equal(created[0].status, "refined");
  });

  it("reverts grouped features to raw on subprocess failure", async () => {
    const f1 = store.addFeature("will fail");
    const f2 = store.addFeature("also fails");

    // Simulate a failing subprocess (exit code 1, no result)
    spawnHandler = fakeClaudeProcess([], 1);

    await assert.rejects(
      () => refiner.refineBatch(store, [f1.id, f2.id]),
      /claude exited with code 1/
    );

    // Features should be reverted to raw
    assert.equal(store.getFeature(f1.id).status, "raw");
    assert.equal(store.getFeature(f2.id).status, "raw");
  });

  it("reverts to raw on invalid JSON result", async () => {
    const f1 = store.addFeature("bad json");

    const events = [
      { type: "result", result: "this is not valid json [[[" },
    ];

    spawnHandler = fakeClaudeProcess(events);

    await assert.rejects(
      () => refiner.refineBatch(store, [f1.id]),
      /Failed to parse refinement result/
    );

    assert.equal(store.getFeature(f1.id).status, "raw");
  });

  it("throws when no valid features are provided", async () => {
    await assert.rejects(
      () => refiner.refineBatch(store, ["f-nonexistent"]),
      /No valid features to refine/
    );
  });

  it("refine() wraps refineBatch for single feature", async () => {
    const f1 = store.addFeature("single feature");

    const tickets = [
      { title: "Single", spec: "Spec", project: "p", sourceIds: [f1.id], status: "refined", subtasks: [], estimatedAgents: 1 },
    ];

    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));
    const result = await refiner.refine(store, f1.id);

    assert.ok(result);
    assert.equal(store.getFeature(f1.id).status, "grouped");
  });

  it("handles needs-info status from Claude", async () => {
    const f1 = store.addFeature("something vague");

    const tickets = [
      {
        title: "Unclear request",
        spec: "Need more details",
        project: "katulong",
        sourceIds: [f1.id],
        status: "needs-info",
        needsInfoReason: "The idea is too vague to refine",
        subtasks: [],
        estimatedAgents: 0,
      },
    ];

    spawnHandler = fakeClaudeProcess(buildStreamEvents(tickets));
    const created = await refiner.refineBatch(store, [f1.id]);

    assert.equal(created.length, 1);
    assert.equal(created[0].status, "needs-info");
  });
});

// ── Route tests for batch refine endpoint ──────────────────────────

describe("Batch refine route", () => {
  let testDir;
  let store;
  let routes;
  let routeMap;
  let refineBatchCalls;

  function createMockRes() {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers); },
      write(data) { res.body = (res.body || "") + data; },
      end(data) { if (data) res.body = (res.body || "") + data; },
    };
    return res;
  }

  function createMockReq(method, url, body, headers = {}) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    return {
      method, url,
      headers: { host: "localhost:3000", ...headers },
      on(event, cb) {
        if (event === "data") chunks.forEach((c) => cb(c));
        if (event === "end") cb();
        if (event === "close") {}
      },
    };
  }

  function json(res, status, data) { res.statusCode = status; res.body = JSON.stringify(data); }
  function parseJSON(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
  }
  function auth(handler) { return handler; }
  function csrf(handler) { return handler; }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-batch-route-test-"));
    store = createDispatchStore(testDir);
    refineBatchCalls = [];

    const mockRefiner = {
      refineBatch: async (s, ids) => {
        refineBatchCalls.push(ids);
        return [];
      },
      refine: async () => ({}),
    };
    const executor = { dispatch: async () => ({}), cancel: async () => true };

    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({ store, refiner: mockRefiner, executor, json, parseJSON, auth, csrf });
    routeMap = {};
    for (const r of routes) {
      routeMap[r.prefix ? `${r.method} PREFIX:${r.prefix}` : `${r.method} ${r.path}`] = r;
    }
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("POST /api/dispatch/refine with featureIds returns 202", async () => {
    const f1 = store.addFeature("idea one");
    const f2 = store.addFeature("idea two");

    const route = routeMap["POST /api/dispatch/refine"];
    assert.ok(route, "Batch refine route should exist");

    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id, f2.id] });
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.ok(body.ok);
    assert.equal(body.count, 2);
  });

  it("POST /api/dispatch/refine with all:true refines all raw", async () => {
    store.addFeature("raw one");
    store.addFeature("raw two");
    const done = store.addFeature("already done");
    store.updateFeature(done.id, { status: "refined" });

    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { all: true });
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 2, "Should only refine raw features");
  });

  it("rejects non-raw features with 400", async () => {
    const f1 = store.addFeature("refined already");
    store.updateFeature(f1.id, { status: "refined" });

    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id] });
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes("not raw"));
  });

  it("rejects missing featureIds with 400", async () => {
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", {});
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 400);
  });

  it("rejects nonexistent feature IDs with 400", async () => {
    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: ["f-nonexistent"] });
    const res = createMockRes();
    await route.handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes("not found"));
  });

  it("marks features as grouped immediately", async () => {
    const f1 = store.addFeature("to group");

    const route = routeMap["POST /api/dispatch/refine"];
    const req = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id] });
    const res = createMockRes();
    await route.handler(req, res);

    // Feature should already be grouped (sync, before refinement completes)
    const updated = store.getFeature(f1.id);
    assert.equal(updated.status, "grouped");
    assert.ok(updated.groupedInto);
  });

  it("single-feature refine endpoint still works", async () => {
    const f1 = store.addFeature("single idea");

    const route = routeMap["POST PREFIX:/api/dispatch/refine/"];
    assert.ok(route, "Single-feature refine route should still exist");

    const req = createMockReq("POST", `/api/dispatch/refine/${f1.id}`);
    const res = createMockRes();
    await route.handler(req, res, f1.id);

    assert.equal(res.statusCode, 202);
    const updated = store.getFeature(f1.id);
    assert.equal(updated.status, "grouped");
  });
});

// ── Refine activity SSE lifecycle ──────────────────────────────────
//
// Verifies that the sidebar activity panel's data source (SSE events)
// actually fires when a refine starts, streams progress, and finishes.
// Uses a mock refiner that invokes onProgress synchronously before
// resolving, so the route handler's streaming path is exercised end-
// to-end without needing a real claude subprocess.

describe("Refine activity SSE events", () => {
  let testDir;
  let store;
  let routes;
  let routeMap;

  function createMockRes() {
    const res = {
      statusCode: null,
      headers: {},
      body: null,
      writeHead(code, headers) { res.statusCode = code; Object.assign(res.headers, headers); },
      write(data) { res.body = (res.body || "") + data; },
      end(data) { if (data) res.body = (res.body || "") + data; },
    };
    return res;
  }

  function createSseReq() {
    const closeCbs = [];
    return {
      method: "GET",
      url: "/api/dispatch/stream",
      headers: { host: "localhost:3000" },
      on(event, cb) { if (event === "close") closeCbs.push(cb); },
      _close: () => closeCbs.forEach((cb) => cb()),
    };
  }

  function createMockReq(method, url, body) {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
    return {
      method, url,
      headers: { host: "localhost:3000" },
      on(event, cb) {
        if (event === "data") chunks.forEach((c) => cb(c));
        if (event === "end") cb();
        if (event === "close") {}
      },
    };
  }

  function json(res, status, data) { res.statusCode = status; res.body = JSON.stringify(data); }
  function parseJSON(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
  }
  function auth(handler) { return handler; }
  function csrf(handler) { return handler; }

  /** Parse an SSE body string into [{event, data}] records. */
  function parseEvents(body) {
    const out = [];
    for (const block of (body || "").split("\n\n")) {
      let event = null;
      let data = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (event && data) {
        try { out.push({ event, data: JSON.parse(data) }); }
        catch { out.push({ event, data }); }
      }
    }
    return out;
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "katulong-activity-sse-test-"));
    store = createDispatchStore(testDir);
  });

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  it("broadcasts refine-started/progress/completed and includes them in snapshot", async () => {
    // Mock refiner: invokes onProgress twice, then resolves.
    const mockRefiner = {
      refineBatch: async (s, ids, opts = {}) => {
        if (opts.onProgress) {
          opts.onProgress("Listing projects");
          opts.onProgress("Reading katulong CLAUDE.md");
        }
        return [];
      },
      refine: async () => ({}),
    };
    const executor = { dispatch: async () => ({}), cancel: async () => true };

    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({
      store, refiner: mockRefiner, executor, json, parseJSON, auth, csrf,
    });
    routeMap = {};
    for (const r of routes) {
      routeMap[r.prefix ? `${r.method} PREFIX:${r.prefix}` : `${r.method} ${r.path}`] = r;
    }

    // Open the SSE stream — the response accumulates all broadcast events.
    const streamReq = createSseReq();
    const streamRes = createMockRes();
    await routeMap["GET /api/dispatch/stream"].handler(streamReq, streamRes);

    // The initial snapshot should include an empty refines array.
    const snapshotEvents = parseEvents(streamRes.body);
    const snapshot = snapshotEvents.find((e) => e.event === "snapshot");
    assert.ok(snapshot, "Should emit initial snapshot");
    assert.deepEqual(snapshot.data.refines, [], "Snapshot should include empty refines array");

    // Trigger a batch refine.
    const f1 = store.addFeature("idea one");
    const f2 = store.addFeature("idea two");
    const refineReq = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id, f2.id] });
    const refineRes = createMockRes();
    await routeMap["POST /api/dispatch/refine"].handler(refineReq, refineRes);
    // Yield so the background refineBatch promise resolves and schedules
    // its completion broadcast.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const events = parseEvents(streamRes.body);
    const types = events.map((e) => e.event);

    assert.ok(types.includes("refine-started"), `Expected refine-started in ${types.join(",")}`);
    assert.ok(types.includes("refine-progress"), `Expected refine-progress in ${types.join(",")}`);
    assert.ok(types.includes("refine-completed"), `Expected refine-completed in ${types.join(",")}`);

    // refine-started carries a session with count and bullets array.
    const started = events.find((e) => e.event === "refine-started");
    assert.equal(started.data.session.count, 2);
    assert.equal(started.data.session.status, "running");
    assert.deepEqual(started.data.session.featureIds, [f1.id, f2.id]);

    // refine-progress carries the bullet text + timestamp.
    const progress = events.filter((e) => e.event === "refine-progress");
    assert.equal(progress.length, 2);
    assert.equal(progress[0].data.bullet.text, "Listing projects");
    assert.equal(progress[1].data.bullet.text, "Reading katulong CLAUDE.md");
    // All progress events share the sessionTag with refine-started.
    assert.equal(progress[0].data.sessionTag, started.data.session.sessionTag);
  });

  it("broadcasts refine-failed when the background refine rejects", async () => {
    const mockRefiner = {
      refineBatch: async () => { throw new Error("subprocess died"); },
      refine: async () => ({}),
    };
    const executor = { dispatch: async () => ({}), cancel: async () => true };

    const { createDispatchRoutes } = await import("../lib/dispatch-routes.js");
    routes = createDispatchRoutes({
      store, refiner: mockRefiner, executor, json, parseJSON, auth, csrf,
    });
    routeMap = {};
    for (const r of routes) {
      routeMap[r.prefix ? `${r.method} PREFIX:${r.prefix}` : `${r.method} ${r.path}`] = r;
    }

    const streamReq = createSseReq();
    const streamRes = createMockRes();
    await routeMap["GET /api/dispatch/stream"].handler(streamReq, streamRes);

    const f1 = store.addFeature("will fail");
    const refineReq = createMockReq("POST", "/api/dispatch/refine", { featureIds: [f1.id] });
    const refineRes = createMockRes();
    await routeMap["POST /api/dispatch/refine"].handler(refineReq, refineRes);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const events = parseEvents(streamRes.body);
    const types = events.map((e) => e.event);
    assert.ok(types.includes("refine-started"));
    assert.ok(types.includes("refine-failed"), `Expected refine-failed in ${types.join(",")}`);
    const failed = events.find((e) => e.event === "refine-failed");
    assert.equal(failed.data.detail, "subprocess died");
  });
});
