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
 * topic broker (captures published messages).
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

function fakeAssistantLine(text, extraTools = []) {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "text", text },
        { type: "tool_use", name: "Read", input: { file_path: "/a.js" } },
        ...extraTools.map((t) => ({ type: "tool_use", ...t })),
      ],
    },
  };
}

function fakeAssistantToolOnly(tools) {
  return {
    type: "assistant",
    message: {
      content: tools.map((t) => ({ type: "tool_use", ...t })),
    },
  };
}

function fakeToolResultLine(toolUseId, content, { isError = false } = {}) {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError },
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
    assert.throws(() => createClaudeProcessor({ topicBroker: broker }), /watchlist/);
    assert.throws(() => createClaudeProcessor({ watchlist }), /topicBroker/);
  });

  it("throws on acquire for a uuid that's not on the watchlist", async () => {
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
    });
    await assert.rejects(() => processor.acquire(UUID), /not on the watchlist/);
    processor.destroy();
  });

  it("publishes a prompt event for each user entry with text", async () => {
    writeTranscript(transcriptPath, [
      fakeUserLine("refactor the auth handler"),
      fakeAssistantLine("ok, starting now"),
      fakeUserLine("also add a test"),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist, topicBroker: broker, pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "prompt").length >= 2,
    );

    const prompts = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "prompt");
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].step, "refactor the auth handler");
    assert.equal(prompts[1].step, "also add a test");
    assert.ok(prompts[0].entryId);
    assert.ok(Number.isFinite(prompts[0].ts));

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

  it("refcount: second acquire does not start another worker; release drops to zero without stopping the worker", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("hi")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      pollIntervalMs: 50,
    });

    const r1 = await processor.acquire(UUID);
    const r2 = await processor.acquire(UUID);
    assert.strictEqual(r1, 1);
    assert.strictEqual(r2, 2);
    assert.strictEqual(processor.refcount(UUID), 2);

    assert.strictEqual(processor.release(UUID), 1);
    assert.strictEqual(processor.has(UUID), true);

    // Refcount 0 no longer stops the worker — it stays alive at the
    // idle poll cadence so the cursor advances during subscriber gaps.
    assert.strictEqual(processor.release(UUID), 0);
    assert.strictEqual(processor.has(UUID), true);
    assert.strictEqual(processor.refcount(UUID), 0);

    processor.destroy();
    assert.strictEqual(processor.has(UUID), false);
  });

  it("release on a uuid that's not active returns 0", async () => {
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
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
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(async () => {
      const entry = await watchlist.get(UUID);
      return entry.lastProcessedLine === 2;
    });
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

  it("keeps polling after the last release, at the idle cadence, so the cursor never freezes", async () => {
    // The whole point of decoupling worker lifecycle from subscribers:
    // a subscriber gap (page refresh, server restart, disconnect) must
    // not freeze the cursor. The worker stays alive at idlePollIntervalMs
    // and keeps advancing; when the next subscriber attaches they see
    // up-to-date state instead of stale data pinned to the previous
    // subscriber's last seq.
    writeTranscript(transcriptPath, [fakeAssistantLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      pollIntervalMs: 20,
      idlePollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.some((p) => JSON.parse(p.message).status === "reply"),
    );
    const beforeRelease = broker.published.filter((p) => JSON.parse(p.message).status === "reply").length;
    processor.release(UUID);

    appendTranscript(transcriptPath, [fakeAssistantLine("while no one's watching")]);
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "reply").length > beforeRelease,
    );

    const entry = await watchlist.get(UUID);
    assert.strictEqual(entry.lastProcessedLine, 2);
    assert.strictEqual(processor.has(UUID), true);
    processor.destroy();
  });

  it("boot-spawns idle workers for uuids already on the watchlist at creation", async () => {
    // Server restart scenario: the watchlist survives on disk. When the
    // processor comes back up it should immediately start polling
    // every entry at the idle cadence — without waiting for someone to
    // open a feed tile. Otherwise the first subscriber after restart
    // hits a long stall while the worker initializes.
    writeTranscript(transcriptPath, [fakeAssistantLine("pre-existing reply")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      pollIntervalMs: 500,
      idlePollIntervalMs: 20,
    });

    await processor.ready();
    assert.strictEqual(processor.has(UUID), true);
    assert.strictEqual(processor.refcount(UUID), 0);

    await waitFor(() =>
      broker.published.some((p) => JSON.parse(p.message).status === "reply"),
    );
    processor.destroy();
  });

  it("acquire after an idle period kicks an immediate cycle", async () => {
    // After release drops refcount to 0 the worker idles on a slow
    // cadence. A subscriber reconnecting should not wait a full idle
    // interval to see fresh state — acquire on 0→1 must trigger an
    // immediate poll.
    writeTranscript(transcriptPath, [fakeAssistantLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      pollIntervalMs: 20,
      idlePollIntervalMs: 60_000, // effectively disables idle catch-up for this test
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.some((p) => JSON.parse(p.message).status === "reply"),
    );
    processor.release(UUID);
    // Wait a beat to ensure any in-flight cycle settles and the next
    // scheduleNext uses the slow idle interval.
    await new Promise((r) => setTimeout(r, 30));

    appendTranscript(transcriptPath, [fakeAssistantLine("second")]);
    const before = broker.published.filter((p) => JSON.parse(p.message).status === "reply").length;
    await processor.acquire(UUID);
    // An immediate fast cycle should catch the second line well before
    // idlePollIntervalMs (60s) would.
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "reply").length > before,
    { timeoutMs: 500 });

    processor.destroy();
  });

  it("stops the worker when the watchlist entry is removed mid-run", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("first")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      pollIntervalMs: 20,
      idlePollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    assert.strictEqual(processor.has(UUID), true);

    await watchlist.remove(UUID);
    await waitFor(() => !processor.has(UUID));
    processor.destroy();
  });

  it("destroy() stops all workers", async () => {
    writeTranscript(transcriptPath, [fakeAssistantLine("one")]);
    await watchlist.add(UUID, { transcriptPath });

    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: makeBroker(),
      pollIntervalMs: 20,
    });

    await processor.acquire(UUID);
    assert.strictEqual(processor.has(UUID), true);
    processor.destroy();
    assert.strictEqual(processor.has(UUID), false);
    await assert.rejects(() => processor.acquire(UUID), /destroyed/);
  });

  it("attaches files from tools in the reply's turn to the reply event", async () => {
    // A reply bundles files touched by earlier tool-only assistant entries
    // in the same turn, not just its own tools. The UI renders these as
    // clickable chips on the collapsed summary so the user can jump to
    // what was changed.
    writeTranscript(transcriptPath, [
      fakeUserLine("refactor auth"),
      fakeAssistantToolOnly([
        { name: "Read", input: { file_path: "/src/auth.js", offset: 1 } },
        { name: "Edit", input: { file_path: "/src/session.js" } },
      ]),
      fakeAssistantLine("Done — updated both files."),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist,
      topicBroker: broker,
      pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() => broker.published.some((p) => JSON.parse(p.message).status === "reply"));

    const reply = broker.published
      .map((p) => JSON.parse(p.message))
      .find((m) => m.status === "reply");
    assert.ok(Array.isArray(reply.files));
    // fakeAssistantLine defaults to adding /a.js too; Read before Edit
    // for the standalone assistant line.
    const paths = reply.files.map((f) => f.path);
    assert.ok(paths.includes("/src/auth.js"));
    assert.ok(paths.includes("/src/session.js"));
    assert.ok(paths.includes("/a.js"));
    const authFile = reply.files.find((f) => f.path === "/src/auth.js");
    assert.equal(authFile.line, 1);

    processor.destroy();
  });

  it("publishes a running tool event for each tool_use block with an id", async () => {
    // Tool cards in the feed need a "running" stamp the moment a
    // tool_use lands so the user sees the in-progress state before
    // the result arrives. Blocks without an id are ignored (legacy
    // transcripts, malformed entries) since the frontend keys cards
    // on toolUseId and can't correlate a result without one.
    writeTranscript(transcriptPath, [
      fakeAssistantToolOnly([
        { id: "toolu_RUN_1", name: "Bash", input: { command: "ls -la" } },
        { id: "toolu_RUN_2", name: "Read", input: { file_path: "/src/auth.js" } },
        { name: "NoId", input: {} },
      ]),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist, topicBroker: broker, pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "tool").length >= 2,
    );

    const toolEvents = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "tool");
    assert.equal(toolEvents.length, 2, "ignores tool_use blocks with no id");
    assert.deepEqual(
      toolEvents.map((e) => ({ id: e.toolUseId, state: e.state, name: e.name })),
      [
        { id: "toolu_RUN_1", state: "running", name: "Bash" },
        { id: "toolu_RUN_2", state: "running", name: "Read" },
      ],
    );
    assert.deepEqual(toolEvents[0].input, { command: "ls -la" });

    processor.destroy();
  });

  it("flips running→ok on matching tool_result (is_error false)", async () => {
    writeTranscript(transcriptPath, [
      fakeAssistantToolOnly([{ id: "toolu_OK_1", name: "Bash", input: { command: "echo hi" } }]),
      fakeToolResultLine("toolu_OK_1", "hi\n"),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist, topicBroker: broker, pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "tool").length >= 2,
    );

    const toolEvents = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "tool");
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(
      toolEvents.map((e) => ({ id: e.toolUseId, state: e.state })),
      [
        { id: "toolu_OK_1", state: "running" },
        { id: "toolu_OK_1", state: "ok" },
      ],
    );
    assert.equal(toolEvents[1].output, "hi\n");

    processor.destroy();
  });

  it("flips running→error on matching tool_result (is_error true)", async () => {
    writeTranscript(transcriptPath, [
      fakeAssistantToolOnly([{ id: "toolu_ERR_1", name: "Bash", input: { command: "false" } }]),
      fakeToolResultLine("toolu_ERR_1", "command failed", { isError: true }),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist, topicBroker: broker, pollIntervalMs: 50,
    });

    await processor.acquire(UUID);
    await waitFor(() =>
      broker.published.filter((p) => JSON.parse(p.message).status === "tool" && JSON.parse(p.message).state === "error").length >= 1,
    );

    const errorEvent = broker.published
      .map((p) => JSON.parse(p.message))
      .find((m) => m.status === "tool" && m.state === "error");
    assert.equal(errorEvent.toolUseId, "toolu_ERR_1");
    assert.equal(errorEvent.output, "command failed");

    processor.destroy();
  });

  it("emits tool events straddling a slice boundary in order", async () => {
    // Backlog catch-up reads in sliceLimit-sized chunks. A tool_use
    // landing in chunk N with its tool_result in chunk N+1 must still
    // surface as running then ok/error — the accumulator lives on the
    // worker across cycles, so the correlation holds.
    writeTranscript(transcriptPath, [
      fakeAssistantToolOnly([{ id: "toolu_SPLIT", name: "Bash", input: { command: "date" } }]),
      fakeToolResultLine("toolu_SPLIT", "today"),
    ]);
    await watchlist.add(UUID, { transcriptPath });

    const broker = makeBroker();
    const processor = createClaudeProcessor({
      watchlist, topicBroker: broker, pollIntervalMs: 500, sliceLimit: 1,
    });

    await processor.acquire(UUID);
    await waitFor(async () => {
      const entry = await watchlist.get(UUID);
      return entry.lastProcessedLine === 2;
    });

    const toolEvents = broker.published
      .map((p) => JSON.parse(p.message))
      .filter((m) => m.status === "tool");
    assert.deepEqual(
      toolEvents.map((e) => ({ id: e.toolUseId, state: e.state })),
      [
        { id: "toolu_SPLIT", state: "running" },
        { id: "toolu_SPLIT", state: "ok" },
      ],
    );

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
