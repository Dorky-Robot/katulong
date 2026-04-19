/**
 * Session summarizer tests.
 *
 * The summarizer reads each live session's RingBuffer tail, hashes it,
 * and asks Ollama for `{ title, summary }` when the hash changes.
 * These tests drive it with a fake session manager + fake callOllama
 * and assert the right meta keys land where the frontend reads them.
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  createSessionSummarizer,
  parseSummaryResponse,
} from "../lib/session-summarizer.js";

function makeFakeSession({ name, buffer, alive = true }) {
  const meta = {};
  return {
    name,
    alive,
    meta,
    pullTail(maxBytes) {
      const slice = buffer.slice(Math.max(0, buffer.length - maxBytes));
      return { data: slice, cursor: buffer.length };
    },
    setMeta(ns, value) {
      if (value === null || value === undefined) delete meta[ns];
      else meta[ns] = value;
    },
  };
}

function makeFakeManager(sessions) {
  const byName = new Map(sessions.map((s) => [s.name, s]));
  return {
    listSessions() {
      return { sessions: [...byName.values()].map((s) => ({ name: s.name, alive: s.alive })) };
    },
    getSession(name) {
      return byName.get(name);
    },
    _remove(name) {
      byName.delete(name);
    },
  };
}

function okOllama(response = '{"title": "Editing Auth Module", "summary": "User is refactoring the login flow."}') {
  const calls = [];
  const fn = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return response;
  };
  fn.calls = calls;
  return fn;
}

describe("parseSummaryResponse", () => {
  it("accepts strict JSON", () => {
    const out = parseSummaryResponse('{"title":"Debugging Tests","summary":"Running the full suite to track a flake."}');
    assert.deepStrictEqual(out, {
      title: "Debugging Tests",
      summary: "Running the full suite to track a flake.",
    });
  });

  it("extracts JSON embedded in prose or fenced blocks", () => {
    const fenced = "```json\n{\"title\":\"A\",\"summary\":\"B.\"}\n```";
    assert.deepStrictEqual(parseSummaryResponse(fenced), { title: "A", summary: "B." });

    const prose = "Sure! Here is the summary:\n{\"title\":\"A\",\"summary\":\"B.\"}\nHope that helps.";
    assert.deepStrictEqual(parseSummaryResponse(prose), { title: "A", summary: "B." });
  });

  it("returns null for garbage", () => {
    assert.strictEqual(parseSummaryResponse(""), null);
    assert.strictEqual(parseSummaryResponse("no json here"), null);
    assert.strictEqual(parseSummaryResponse('{"title":"A"}'), null); // missing summary
    assert.strictEqual(parseSummaryResponse("{broken json"), null);
  });

  it("clamps long strings", () => {
    const longTitle = "x".repeat(200);
    const longSummary = "y".repeat(500);
    const out = parseSummaryResponse(JSON.stringify({ title: longTitle, summary: longSummary }));
    assert.ok(out.title.length <= 60);
    assert.ok(out.summary.length <= 300);
  });
});

describe("createSessionSummarizer", () => {
  it("throws when required opts are missing", () => {
    assert.throws(() => createSessionSummarizer({ callOllama: () => {} }), /sessionManager/);
    assert.throws(() => createSessionSummarizer({ sessionManager: {} }), /callOllama/);
  });

  it("writes meta.summary and meta.autoTitle when given enough content", async () => {
    const session = makeFakeSession({
      name: "kat_test",
      buffer: "cd ~/proj\nnpm test\n" + "PASS test/auth.test.js\n".repeat(50),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    // runOnce kicks cycle() which fires summarizeOne() fire-and-forget;
    // give the microtask queue a beat to settle the Ollama await.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(session.meta.autoTitle, "Editing Auth Module");
    assert.ok(session.meta.summary);
    assert.strictEqual(session.meta.summary.short, "Editing Auth Module");
    assert.strictEqual(session.meta.summary.long, "User is refactoring the login flow.");
    assert.ok(Number.isFinite(session.meta.summary.updatedAt));
    assert.strictEqual(callOllama.calls.length, 1);

    s.stop();
  });

  it("skips sessions below minContentChars", async () => {
    const session = makeFakeSession({ name: "kat_tiny", buffer: "$ " });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 400 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(callOllama.calls.length, 0);
    assert.strictEqual(session.meta.autoTitle, undefined);
    assert.strictEqual(session.meta.summary, undefined);
    s.stop();
  });

  it("dedupes by hash — identical window skips Ollama on the second cycle", async () => {
    const buffer = "some meaningful terminal output\n".repeat(30);
    const session = makeFakeSession({ name: "kat_dupe", buffer });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Same buffer — same hash — second cycle must not call Ollama.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    s.stop();
  });

  it("re-summarizes when the window changes", async () => {
    const session = makeFakeSession({
      name: "kat_change",
      buffer: "initial buffer content\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Mutate the buffer — hash must change, Ollama must be called again.
    session.pullTail = (n) => ({
      data: ("changed output\n".repeat(50)).slice(-n),
      cursor: 0,
    });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 2);

    s.stop();
  });

  it("ignores dead sessions and prunes their state", async () => {
    const alive = makeFakeSession({ name: "kat_alive", buffer: "x\n".repeat(300) });
    const dead = makeFakeSession({ name: "kat_dead", buffer: "y\n".repeat(300), alive: false });
    const mgr = makeFakeManager([alive, dead]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dead.meta.autoTitle, undefined);
    assert.ok(alive.meta.autoTitle);
    s.stop();
  });

  it("drops per-session state when the session disappears", async () => {
    const session = makeFakeSession({ name: "kat_gone", buffer: "x\n".repeat(300) });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();
    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });

    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(s._state.size, 1);

    mgr._remove("kat_gone");
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(s._state.size, 0);

    s.stop();
  });

  it("does not set meta on unparseable Ollama responses", async () => {
    const session = makeFakeSession({ name: "kat_junk", buffer: "x\n".repeat(300) });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama("sorry, I can't summarize");

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(session.meta.autoTitle, undefined);
    assert.strictEqual(session.meta.summary, undefined);
    s.stop();
  });

  it("strips ANSI escape sequences before hashing", async () => {
    // Two buffers that differ only in ANSI color codes should hash to
    // the same window after stripping — so the second pass dedupes.
    const plain = "ls -la\ntotal 24\ndrwxr-xr-x  5 user  staff  160 Apr 18 10:00 .\n".repeat(20);
    const colored = "ls -la\ntotal 24\n\x1b[34mdrwxr-xr-x\x1b[0m  5 user  staff  160 Apr 18 10:00 .\n".repeat(20);
    const session = makeFakeSession({ name: "kat_ansi", buffer: plain });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Same content with ANSI codes — stripAnsi should normalize these.
    session.pullTail = (n) => ({ data: colored.slice(-n), cursor: 0 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1, "ANSI-only difference must not trigger a re-summary");

    s.stop();
  });
});
