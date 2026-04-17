/**
 * Claude processor tests.
 *
 * The processor is the refcounted layer between subscribers and the narrator:
 *   acquire(uuid) → narrate loop starts, publishes to claude/<uuid>
 *   release(uuid) → loop stops on last caller
 *   watchlist.advance is called only after a successful narrate
 *
 * We use a real watchlist (tmpdir) and a real transcript file, but a fake
 * topic broker (captures published messages) and a fake callOllama.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWatchlist } from "../lib/claude-watchlist.js";
import { createClaudeProcessor } from "../lib/claude-processor.js";

const UUID = "ff16582e-bbb4-49c6-90cf-e731be656442";

function makeBroker() {
  const published = [];
  return {
    published,
    publish(topic, message) {
      published.push({ topic, message });
    },
  };
}

function writeTranscript(path, lines) {
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function appendTranscript(path, lines) {
  appendFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function fakeUserLine(text) {
  return { type: "user", message: { content: text } };
}

function fakeAssistantLine(text) {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "text", text },
        { type: "tool_use", name: "Read", input: { file_path: "/a.js" } },
      ],
    },
  };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor: timed out");
}

describe("createClaudeProcessor", () => {
  let dataDir;
  let transcriptPath;
  let watchlist;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-processor-"));
    transcriptPath = join(dataDir, "transcript.jsonl");
    watchlist = createWatchlist({ dataDir });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects missing args", () => {
    const broker = makeBroker();
    const callOllama = async () => "x";
    assert.throws(() => createClaudeProcessor({ topicBroker: broker, callOllama }), /watchlist/);
    assert.throws(() => createClaudeProcessor({ watchlist, callOllama }), /topicBroker/);
    assert.throws(
      () => createClaudeProcessor({ watchlist, topicBroker: broker }),
      /callOllama/,
    );
  });

  it("throws on acquire for a uuid that's not on the watchlist", async () => {
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "OBJECTIVE: x\n---\nY",
    });
    await assert.rejects(() => processor.acquire(UUID), /not on the watchlist/);
    processor.destroy();
  });

  it("spins up a worker on first acquire and narrates the backlog", async () => {
    writeTranscript(transcriptPath, [
      fakeUserLine("fix the login bug"),
      fakeAssistantLine("ok"),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    let callCount = 0;
    const callOllama = async () => {
      callCount += 1;
      return "OBJECTIVE: Fix login\n---\nReading `a.js`.";
    };
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.length >= 2);

    const messages = broker.published.map(p => JSON.parse(p.message));
    assert.deepStrictEqual(messages.map(m => m.status), ["narrative", "summary"]);
    assert.strictEqual(broker.published[0].topic, `claude/${UUID}`);

    const entry = await watchlist.get(UUID);
    assert.strictEqual(entry.lastProcessedLine, 2);
    assert.ok(callCount >= 1);
    processor.destroy();
  });

  it("refcount: second acquire does not start another worker; release drops to zero", async () => {
    writeTranscript(transcriptPath, [fakeUserLine("hi")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "OBJECTIVE: x\n---\nY",
      pollIntervalMs: 50,
    });

    const r1 = await processor.acquire(UUID);
    const r2 = await processor.acquire(UUID);
    assert.strictEqual(r1, 1);
    assert.strictEqual(r2, 2);
    assert.strictEqual(processor.refcount(UUID), 2);

    assert.strictEqual(processor.release(UUID), 1);
    assert.strictEqual(processor.has(UUID), true);

    assert.strictEqual(processor.release(UUID), 0);
    assert.strictEqual(processor.has(UUID), false);

    processor.destroy();
  });

  it("release on a uuid that's not active returns 0", async () => {
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "x",
    });
    assert.strictEqual(processor.release(UUID), 0);
    processor.destroy();
  });

  it("does not advance the cursor when the narrate call fails", async () => {
    writeTranscript(transcriptPath, [fakeUserLine("fix it")]);
    await watchlist.add(UUID, { transcriptPath });

    const callOllama = async () => { throw new Error("ollama down"); };
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    // Let a few cycles fail.
    await new Promise(r => setTimeout(r, 200));

    const entry = await watchlist.get(UUID);
    assert.strictEqual(entry.lastProcessedLine, 0);
    processor.destroy();
  });

  it("advances past lines that normalize to no entries without calling Ollama", async () => {
    // Session metadata lines only — nothing the narrator can work with.
    writeTranscript(transcriptPath, [
      { type: "summary", summary: "old" },
      { type: "summary", summary: "still old" },
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    let called = false;
    const callOllama = async () => { called = true; return "x"; };
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(async () => {
      const entry = await watchlist.get(UUID);
      return entry.lastProcessedLine === 2;
    });
    assert.strictEqual(called, false);
    assert.strictEqual(broker.published.length, 0);
    processor.destroy();
  });

  it("picks up newly appended lines on subsequent polls", async () => {
    writeTranscript(transcriptPath, [fakeUserLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const callOllama = async () => "OBJECTIVE: x\n---\nY";
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 30,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.length >= 2);
    const before = broker.published.length;

    appendTranscript(transcriptPath, [fakeUserLine("second prompt")]);

    await waitFor(() => broker.published.length > before);
    const entry = await watchlist.get(UUID);
    assert.strictEqual(entry.lastProcessedLine, 2);

    processor.destroy();
  });

  it("stops polling after the last release (no more publishes)", async () => {
    writeTranscript(transcriptPath, [fakeUserLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const callOllama = async () => "OBJECTIVE: x\n---\nY";
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.length >= 2);
    processor.release(UUID);

    const after = broker.published.length;
    appendTranscript(transcriptPath, [fakeUserLine("while no one's watching")]);
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(broker.published.length, after);
    const entry = await watchlist.get(UUID);
    // Cursor stayed where it was — we never processed the new line.
    assert.strictEqual(entry.lastProcessedLine, 1);
    processor.destroy();
  });

  it("destroy() stops all workers", async () => {
    writeTranscript(transcriptPath, [fakeUserLine("one")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "OBJECTIVE: x\n---\nY",
      pollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    assert.strictEqual(processor.has(UUID), true);
    processor.destroy();
    assert.strictEqual(processor.has(UUID), false);
    await assert.rejects(() => processor.acquire(UUID), /destroyed/);
  });

  it("respects maxConcurrent across workers (no stampede)", async () => {
    const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const pathA = join(dataDir, "a.jsonl");
    const pathB = join(dataDir, "b.jsonl");
    writeTranscript(pathA, [fakeUserLine("A")]);
    writeTranscript(pathB, [fakeUserLine("B")]);
    await watchlist.add(UUID, { transcriptPath: pathA });
    await watchlist.add(UUID_B, { transcriptPath: pathB });

    let inFlight = 0;
    let maxSeen = 0;
    const callOllama = async () => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight -= 1;
      return "OBJECTIVE: x\n---\nY";
    };

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 20,
      maxConcurrent: 1,
    });

    await processor.acquire(UUID);
    await processor.acquire(UUID_B);

    await waitFor(() => {
      const topics = new Set(broker.published.map(p => p.topic));
      return topics.has(`claude/${UUID}`) && topics.has(`claude/${UUID_B}`);
    });

    assert.strictEqual(maxSeen, 1);
    processor.destroy();
  });

  it("catches up in batches when the backlog exceeds sliceLimit", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => fakeUserLine(`p${i}`));
    writeTranscript(transcriptPath, lines);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    let callCount = 0;
    const callOllama = async () => {
      callCount += 1;
      return "OBJECTIVE: x\n---\nY";
    };
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 500, // long poll — we rely on hasMore fast-path
      sliceLimit: 2,
    });

    await processor.acquire(UUID);
    await waitFor(async () => {
      const entry = await watchlist.get(UUID);
      return entry.lastProcessedLine === 5;
    });

    assert.ok(callCount >= 3, `expected ≥3 narrate cycles, got ${callCount}`);
    processor.destroy();
  });
});
