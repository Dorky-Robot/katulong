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

// Variant that exposes `session.cursor` (real Session does) so the
// activity- and volume-gate paths in the summarizer are exercised.
// `appendBytes` simulates new PTY output: it grows the buffer (so
// pullTail returns updated content) and advances the cursor.
function makeFakeSessionWithCursor({ name, buffer, alive = true }) {
  const meta = {};
  let _buffer = buffer;
  let _cursor = buffer.length;
  return {
    name,
    alive,
    meta,
    get cursor() {
      return _cursor;
    },
    appendBytes(text) {
      _buffer += text;
      _cursor += text.length;
    },
    pullTail(maxBytes) {
      const slice = _buffer.slice(Math.max(0, _buffer.length - maxBytes));
      return { data: slice, cursor: _cursor };
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

  it("appends each distinct summary to meta.summaryHistory", async () => {
    const session = makeFakeSession({
      name: "kat_hist",
      buffer: "first buffer content\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);

    let callCount = 0;
    const responses = [
      '{"title":"Phase A","summary":"Doing phase A."}',
      '{"title":"Phase B","summary":"Doing phase B."}',
    ];
    const callOllama = async () => responses[callCount++] ?? responses[responses.length - 1];

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });

    // First cycle → Phase A appended.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.ok(Array.isArray(session.meta.summaryHistory));
    assert.strictEqual(session.meta.summaryHistory.length, 1);
    assert.strictEqual(session.meta.summaryHistory[0].title, "Phase A");
    assert.ok(Number.isFinite(session.meta.summaryHistory[0].at));

    // Mutate the window so the hash changes, then second cycle → Phase B appended.
    session.pullTail = (n) => ({ data: ("second content\n".repeat(50)).slice(-n), cursor: 0 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(session.meta.summaryHistory.length, 2);
    assert.strictEqual(session.meta.summaryHistory[1].title, "Phase B");

    s.stop();
  });

  it("does not append duplicate summaries back-to-back", async () => {
    const session = makeFakeSession({
      name: "kat_dupe_hist",
      buffer: "stable buffer\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);
    // Ollama returns identical content both times. Hash-dedup should
    // skip the second call entirely, but even if a future change makes
    // it call again, duplicate-guard in summaryHistory must prevent
    // duplicate entries.
    const callOllama = okOllama('{"title":"Same","summary":"Same summary."}');

    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(session.meta.summaryHistory.length, 1);
    s.stop();
  });

  it("caps meta.summaryHistory at MAX_HISTORY_ENTRIES (ring behaviour)", async () => {
    const session = makeFakeSession({
      name: "kat_cap",
      buffer: "seed content\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);

    // Pre-seed history near the cap so the test doesn't need 40+ cycles.
    const seed = [];
    for (let i = 0; i < 40; i += 1) {
      seed.push({ title: `old ${i}`, summary: `s ${i}`, at: i });
    }
    session.meta.summaryHistory = seed;

    const callOllama = okOllama('{"title":"Fresh","summary":"Fresh summary."}');
    const s = createSessionSummarizer({ sessionManager: mgr, callOllama, minContentChars: 100 });
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(session.meta.summaryHistory.length, 40);
    // Oldest pushed out, newest landed at the tail.
    assert.strictEqual(session.meta.summaryHistory[0].title, "old 1");
    assert.strictEqual(session.meta.summaryHistory[39].title, "Fresh");
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

  it("activity gate: skips Ollama when cursor moved between ticks (still streaming)", async () => {
    const session = makeFakeSessionWithCursor({
      name: "kat_streaming",
      buffer: "first burst of output\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 50,
    });

    // First cycle: no prior cursor observation, gate is exempt → fires.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Simulate continuous streaming between ticks: cursor moves before
    // the next cycle. Gate must skip without paying for Ollama.
    session.appendBytes("more streaming output\n".repeat(30));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1, "streaming session must not trigger Ollama");

    // Streaming continues — still skipped.
    session.appendBytes("even more output\n".repeat(30));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Settle: no new bytes between ticks → cursor unchanged → gate
    // passes and Ollama is called.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 2, "settled session must trigger Ollama");

    s.stop();
  });

  it("volume gate: skips Ollama when too few new bytes since last summary", async () => {
    const session = makeFakeSessionWithCursor({
      name: "kat_low_volume",
      buffer: "initial burst of meaningful content\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 500,
    });

    // First cycle fires: lastSummarizedCursor=0, cursor>=500, gate exempt.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Trickle: append a tiny chunk, then run two ticks. The first tick
    // sees cursor moved (activity gate); the second tick sees cursor
    // settled but new bytes (5) below the 500 threshold (volume gate).
    session.appendBytes("$ ls\n");
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(
      callOllama.calls.length, 1,
      "trickle below the volume threshold must not trigger Ollama even after settling",
    );

    // Cross the threshold: append a substantial chunk. Same two-tick
    // pattern — activity gate absorbs the cursor move, volume gate
    // passes on the settled tick.
    session.appendBytes("substantial new chunk of output\n".repeat(30));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 2);

    s.stop();
  });

  it("volume gate alone: settled session with no new bytes blocks a second Ollama call", async () => {
    // Isolates the volume gate from the activity gate. After a first
    // summary, the cursor is unchanged on the next tick — activity gate
    // passes — and `cursor - lastSummarizedCursor === 0`, so the volume
    // gate must block on its own.
    const session = makeFakeSessionWithCursor({
      name: "kat_settled_only",
      buffer: "ample initial content\n".repeat(40),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 500,
    });

    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Same cursor on the next tick. Activity gate is satisfied (no
    // movement); volume gate must reject the call by itself.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    s.stop();
  });

  it("unparseable response advances lastSummarizedCursor to suppress retry storm", async () => {
    const session = makeFakeSessionWithCursor({
      name: "kat_garbage_retry",
      buffer: "meaningful content\n".repeat(40),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama("not json at all");

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 500,
    });

    // First tick: gates exempt, Ollama called, parse fails.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);

    // Settled tick: without the failure-path cursor advance, the volume
    // gate (delta=0) would block — but the bug we're guarding against
    // is the previous version not advancing lastSummarizedCursor on
    // parse failure, which left delta=cursor (well above the threshold)
    // and triggered Ollama on every settled tick. Asserts the fix.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(
      callOllama.calls.length, 1,
      "settled session must not retry Ollama after a parse failure",
    );

    s.stop();
  });

  it("thrown Ollama error advances lastSummarizedCursor to suppress retry storm", async () => {
    const session = makeFakeSessionWithCursor({
      name: "kat_throw_retry",
      buffer: "meaningful content\n".repeat(40),
    });
    const mgr = makeFakeManager([session]);
    let attempts = 0;
    const callOllama = async () => {
      attempts += 1;
      throw new Error("network down");
    };

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 500,
    });

    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(attempts, 1);

    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(
      attempts, 1,
      "settled session must not retry Ollama after a thrown error",
    );

    s.stop();
  });

  it("first observation is exempt from the activity gate", async () => {
    const session = makeFakeSessionWithCursor({
      name: "kat_fresh",
      buffer: "fresh session content\n".repeat(30),
    });
    const mgr = makeFakeManager([session]);
    const callOllama = okOllama();

    const s = createSessionSummarizer({
      sessionManager: mgr,
      callOllama,
      minContentChars: 100,
      minNewBytesPerSummary: 100,
    });

    // First tick: lastCursor is null → activity gate exempt → fires
    // without needing a "settled" cycle first.
    await s.runOnce();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(callOllama.calls.length, 1);
    assert.strictEqual(session.meta.autoTitle, "Editing Auth Module");

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
