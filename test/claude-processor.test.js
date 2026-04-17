/**
 * Claude processor tests.
 *
 * The processor is the refcounted layer between subscribers and the
 * transcript reader. For every assistant entry with text it publishes a
 * `reply` event straight from the JSONL (stamped with the entry's own
 * timestamp), then fires a background Ollama call that publishes a
 * `reply-title` enrichment event when it resolves. Reply publishing is
 * independent of Ollama — the feed stays live even when Ollama is down.
 *
 * We use a real watchlist (tmpdir) and a real transcript file, but a fake
 * topic broker (captures published messages) and a controllable fake
 * callOllama.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWatchlist } from "../lib/claude-watchlist.js";
import { createClaudeProcessor } from "../lib/claude-processor.js";

const UUID = "ff16582e-bbb4-49c6-90cf-e731be656442";

function makeBroker() {
  const published = [];
  return {
    published,
    publish(topic, message, meta = {}) {
      published.push({ topic, message, meta });
    },
  };
}

// Counter that rolls each writeTranscript/appendTranscript call.
let _lineCtr = 0;
const BASE_TS_MS = 1_700_000_000_000;
function withBookkeeping(line, i) {
  if (typeof line === "string") return line;
  return {
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    timestamp: new Date(BASE_TS_MS + 1000 * i).toISOString(),
    ...line,
  };
}

function writeTranscript(path, lines) {
  _lineCtr = 0;
  const patched = lines.map((l) => withBookkeeping(l, _lineCtr++));
  writeFileSync(
    path,
    patched.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
}

function appendTranscript(path, lines) {
  const patched = lines.map((l) => withBookkeeping(l, _lineCtr++));
  appendFileSync(
    path,
    patched.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
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
    await new Promise((r) => setTimeout(r, intervalMs));
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
      callOllama: async () => "title",
    });
    await assert.rejects(() => processor.acquire(UUID), /not on the watchlist/);
    processor.destroy();
  });

  it("publishes a reply event per assistant entry with text", async () => {
    writeTranscript(transcriptPath, [
      fakeUserLine("fix the login bug"),
      fakeAssistantLine("Reading auth.js first."),
      fakeUserLine("anything else?"),
      fakeAssistantLine("Found it — missing session flag."),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => "summary",
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.filter((p) => {
        try { return JSON.parse(p.message).status === "reply"; } catch { return false; }
      }).length >= 2,
    );

    const replies = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "reply");
    assert.equal(replies.length, 2);
    assert.equal(replies[0].step, "Reading auth.js first.");
    assert.equal(replies[1].step, "Found it — missing session flag.");
    assert.ok(replies[0].entryId && replies[1].entryId);
    assert.notEqual(replies[0].entryId, replies[1].entryId);

    processor.destroy();
  });

  it("stamps the reply envelope with the transcript entry timestamp", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("hello")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => null,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.length >= 1);

    const replyPub = broker.published.find((p) => JSON.parse(p.message).status === "reply");
    assert.ok(replyPub);
    assert.equal(replyPub.meta.timestamp, BASE_TS_MS, "envelope timestamp == entry ts");
    const body = JSON.parse(replyPub.message);
    assert.equal(body.ts, BASE_TS_MS);

    processor.destroy();
  });

  it("publishes a reply-title enrichment keyed on the same entryId", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("Investigating the auth bug.")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => "Investigating the auth bug",
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.some((p) => {
        try { return JSON.parse(p.message).status === "reply-title"; } catch { return false; }
      }),
    );

    const parsed = broker.published.map((p) => JSON.parse(p.message));
    const reply = parsed.find((m) => m.status === "reply");
    const title = parsed.find((m) => m.status === "reply-title");
    assert.ok(reply && title);
    assert.equal(title.entryId, reply.entryId);
    assert.equal(title.title, "Investigating the auth bug");

    processor.destroy();
  });

  it("still publishes the reply card when Ollama throws", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("ok")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => { throw new Error("ollama down"); },
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.length >= 1);

    const replies = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "reply");
    assert.equal(replies.length, 1, "reply card publishes even when Ollama fails");

    // Give the background enrichment a moment to settle without publishing.
    await new Promise((r) => setTimeout(r, 80));
    const titles = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "reply-title");
    assert.equal(titles.length, 0);

    // Cursor still advances — reply publishing is the load-bearing action.
    const entry = await watchlist.get(UUID);
    assert.equal(entry.lastProcessedLine, 1);

    processor.destroy();
  });

  it("refcount: second acquire does not start another worker; release drops to zero", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("hi")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "t",
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

  it("advances past lines that normalize to no entries without publishing", async () => {
    // All session metadata — no uuid, no timestamp — nothing to render.
    writeFileSync(
      transcriptPath,
      [
        { type: "permission-mode", permissionMode: "default", sessionId: "s" },
        { type: "file-history-snapshot", messageId: "m", snapshot: {}, isSnapshotUpdate: false },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
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
    writeTranscript(transcriptPath, [fakeAssistantLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => "title",
      pollIntervalMs: 30,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.some((p) => JSON.parse(p.message).status === "reply"),
    );
    const before = broker.published.filter((p) => JSON.parse(p.message).status === "reply").length;

    appendTranscript(transcriptPath, [fakeAssistantLine("second")]);

    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "reply").length > before,
    );

    processor.destroy();
  });

  it("stops polling after the last release (no more publishes)", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => "t",
      pollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.some((p) => JSON.parse(p.message).status === "reply"),
    );
    processor.release(UUID);

    const after = broker.published.length;
    appendTranscript(transcriptPath, [fakeAssistantLine("while no one's watching")]);
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(broker.published.length, after);
    const entry = await watchlist.get(UUID);
    assert.strictEqual(entry.lastProcessedLine, 1);
    processor.destroy();
  });

  it("destroy() stops all workers", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("one")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      callOllama: async () => "t",
      pollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    assert.strictEqual(processor.has(UUID), true);
    processor.destroy();
    assert.strictEqual(processor.has(UUID), false);
    await assert.rejects(() => processor.acquire(UUID), /destroyed/);
  });

  it("enriches newest reply first (priority queue, not FIFO)", async () => {
    // When the tile opens on a big backlog, the user wants the most
    // recent titles first — those are the ones about the work Claude is
    // currently doing. Older titles fill in later.
    writeTranscript(transcriptPath, [
      fakeAssistantLine("oldest reply"),
      fakeAssistantLine("middle reply"),
      fakeAssistantLine("newest reply"),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const callOrder = [];
    const gate = { resolve: null };
    const callOllama = async (userPrompt) => {
      callOrder.push(userPrompt);
      // Block the first call so the queue fills with the remaining two
      // before any drain completes — gives the priority order something
      // to act on.
      if (callOrder.length === 1) {
        await new Promise((r) => { gate.resolve = r; });
      }
      const m = userPrompt.match(/CLAUDE REPLY:\n([^\n]+)/);
      return `title for: ${m[1]}`;
    };

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama,
      pollIntervalMs: 50,
      maxConcurrent: 1,
    });

    await processor.acquire(UUID);

    // Wait for all 3 replies to be published and the first Ollama call to
    // have started and be blocked on the gate.
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "reply").length === 3
      && callOrder.length === 1,
    );

    // Unblock the first call. The remaining two should drain newest-first.
    gate.resolve();

    await waitFor(() => callOrder.length === 3);

    // The first call grabbed whichever entry got queued first (oldest, at
    // the head of the slice). The queue then reorders: after that call
    // returns, the drain pulls the newest-ts remaining entry.
    assert.ok(callOrder[1].includes("newest reply"), `call 2 should be newest, got: ${callOrder[1]}`);
    assert.ok(callOrder[2].includes("middle reply"), `call 3 should be middle, got: ${callOrder[2]}`);

    processor.destroy();
  });

  it("catches up in batches when the backlog exceeds sliceLimit", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => fakeAssistantLine(`reply ${i}`));
    writeTranscript(transcriptPath, lines);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      callOllama: async () => "t",
      pollIntervalMs: 500, // long poll — relies on hasMore fast-path
      sliceLimit: 2,
    });

    await processor.acquire(UUID);
    await waitFor(async () => {
      const entry = await watchlist.get(UUID);
      return entry.lastProcessedLine === 5;
    });

    const replies = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "reply");
    assert.equal(replies.length, 5);

    processor.destroy();
  });
});
