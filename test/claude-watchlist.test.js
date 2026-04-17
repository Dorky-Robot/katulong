/**
 * Watchlist Store Tests
 *
 * Covers the opt-in ledger at <dataDir>/claude-watchlist.json:
 *   - add is idempotent (cursor preserved on re-add)
 *   - advance is forward-only
 *   - remove drops the entry cleanly
 *   - concurrent ops serialize correctly through the mutex chain
 *   - corrupt / missing JSON degrades to empty
 *   - writes are atomic (no half-written state on crash)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWatchlist } from "../lib/claude-watchlist.js";

const UUID_A = "ff16582e-bbb4-49c6-90cf-e731be656442";
const UUID_B = "01234567-89ab-cdef-0123-456789abcdef";

describe("createWatchlist", () => {
  let dataDir;
  let watchlistPath;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "katulong-watchlist-test-"));
    watchlistPath = join(dataDir, "claude-watchlist.json");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("requires dataDir", () => {
    assert.throws(() => createWatchlist({}), /dataDir is required/);
  });

  it("starts empty when the file doesn't exist yet", async () => {
    const wl = createWatchlist({ dataDir });
    assert.deepStrictEqual(await wl.list(), {});
    assert.strictEqual(await wl.get(UUID_A), null);
  });

  it("add creates an entry with lastProcessedLine = 0", async () => {
    const wl = createWatchlist({ dataDir });
    const entry = await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    assert.strictEqual(entry.transcriptPath, "/tmp/a.jsonl");
    assert.strictEqual(entry.lastProcessedLine, 0);
    assert.ok(entry.addedAt > 0);

    const persisted = JSON.parse(readFileSync(watchlistPath, "utf-8"));
    assert.strictEqual(persisted[UUID_A].transcriptPath, "/tmp/a.jsonl");
    assert.strictEqual(persisted[UUID_A].lastProcessedLine, 0);
  });

  it("add is idempotent — re-adding preserves cursor", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    await wl.advance(UUID_A, 42);
    const re = await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    assert.strictEqual(re.lastProcessedLine, 42, "cursor must survive re-add");
  });

  it("add refreshes transcriptPath when the file moved", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/old.jsonl" });
    await wl.advance(UUID_A, 5);
    const re = await wl.add(UUID_A, { transcriptPath: "/tmp/new.jsonl" });
    assert.strictEqual(re.transcriptPath, "/tmp/new.jsonl");
    assert.strictEqual(re.lastProcessedLine, 5);
  });

  it("advance is forward-only — stale values are ignored", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    const after10 = await wl.advance(UUID_A, 10);
    assert.strictEqual(after10.lastProcessedLine, 10);
    const stale = await wl.advance(UUID_A, 5);
    assert.strictEqual(stale.lastProcessedLine, 10, "rewind must be ignored");
    const persisted = JSON.parse(readFileSync(watchlistPath, "utf-8"));
    assert.strictEqual(persisted[UUID_A].lastProcessedLine, 10);
  });

  it("advance on an unknown uuid returns null and does not create an entry", async () => {
    const wl = createWatchlist({ dataDir });
    const result = await wl.advance(UUID_A, 10);
    assert.strictEqual(result, null);
    assert.strictEqual(existsSync(watchlistPath), false,
      "advance on a missing uuid should not create the watchlist file");
  });

  it("advance rejects non-integer / negative line counts", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    assert.throws(() => wl.advance(UUID_A, -1), /non-negative integer/);
    assert.throws(() => wl.advance(UUID_A, 1.5), /non-negative integer/);
  });

  it("remove drops an existing entry and returns true", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    await wl.add(UUID_B, { transcriptPath: "/tmp/b.jsonl" });
    const removed = await wl.remove(UUID_A);
    assert.strictEqual(removed, true);
    assert.strictEqual(await wl.get(UUID_A), null);
    assert.ok(await wl.get(UUID_B), "sibling entry must remain");
  });

  it("remove on an unknown uuid returns false", async () => {
    const wl = createWatchlist({ dataDir });
    const removed = await wl.remove(UUID_A);
    assert.strictEqual(removed, false);
  });

  it("list returns a defensive copy", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    const snap = await wl.list();
    snap[UUID_A].lastProcessedLine = 9999;
    const fresh = await wl.list();
    assert.strictEqual(fresh[UUID_A].lastProcessedLine, 0,
      "mutating the snapshot must not leak into the store");
  });

  it("concurrent add + advance do not interleave", async () => {
    const wl = createWatchlist({ dataDir });
    // Fire 20 concurrent ops; the chain must serialize them so the final
    // state is deterministic: one entry, cursor at the highest value we
    // advanced to across the sequence.
    const ops = [];
    ops.push(wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" }));
    for (let i = 1; i <= 10; i++) ops.push(wl.advance(UUID_A, i * 3));
    // Interleave an add for a different uuid to make sure we don't trip over
    // cross-uuid writes either.
    ops.push(wl.add(UUID_B, { transcriptPath: "/tmp/b.jsonl" }));
    for (let i = 1; i <= 10; i++) ops.push(wl.advance(UUID_B, i * 5));
    await Promise.all(ops);

    const final = await wl.list();
    assert.strictEqual(final[UUID_A].lastProcessedLine, 30);
    assert.strictEqual(final[UUID_B].lastProcessedLine, 50);
  });

  it("recovers from corrupt JSON by treating the file as empty", async () => {
    writeFileSync(watchlistPath, "not-json{{{", "utf-8");
    const wl = createWatchlist({ dataDir });
    assert.deepStrictEqual(await wl.list(), {});
    // Subsequent add should succeed and overwrite the corrupt file.
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    const persisted = JSON.parse(readFileSync(watchlistPath, "utf-8"));
    assert.ok(persisted[UUID_A]);
  });

  it("recovers from non-object JSON (e.g. array) by treating as empty", async () => {
    writeFileSync(watchlistPath, "[1,2,3]", "utf-8");
    const wl = createWatchlist({ dataDir });
    assert.deepStrictEqual(await wl.list(), {});
  });

  it("creates the dataDir if it doesn't exist yet", async () => {
    const nested = join(dataDir, "nested", "deeper");
    const wl = createWatchlist({ dataDir: nested });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    assert.ok(existsSync(join(nested, "claude-watchlist.json")));
  });

  it("writes are atomic (no .tmp file left around on success)", async () => {
    const wl = createWatchlist({ dataDir });
    await wl.add(UUID_A, { transcriptPath: "/tmp/a.jsonl" });
    const leftovers = await import("node:fs").then(fs =>
      fs.readdirSync(dataDir).filter(f => f.includes(".tmp."))
    );
    assert.deepStrictEqual(leftovers, []);
  });
});
