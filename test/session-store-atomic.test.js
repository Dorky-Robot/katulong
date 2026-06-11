/**
 * Session store write/load contract.
 *
 * saveNow must be atomic (temp + rename) — a crash mid-write must never
 * leave a truncated sessions.json, because load() treats unparseable
 * content as "no sessions" and every session would silently fail to
 * restore. These tests pin the visible contract: no .tmp residue, valid
 * JSON on disk, and graceful null (not a throw) for missing/corrupt files.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSessionStore } from "../lib/session-persistence.js";

describe("createSessionStore", () => {
  let dir;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "katulong-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("saveNow writes valid JSON and leaves no temp file behind", () => {
    const store = createSessionStore({
      dataDir: dir,
      serialize: () => ({ sessions: { web: { tmuxName: "kat_web" } } }),
    });

    store.saveNow();

    const files = readdirSync(dir);
    assert.deepStrictEqual(files, ["sessions.json"], "no .tmp residue after save");
    const parsed = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8"));
    assert.deepStrictEqual(parsed.sessions.web.tmuxName, "kat_web");
  });

  it("load round-trips what saveNow wrote", () => {
    const store = createSessionStore({
      dataDir: dir,
      serialize: () => ({ sessions: { a: { tmuxName: "kat_a" } } }),
    });
    store.saveNow();
    assert.deepStrictEqual(store.load(), { sessions: { a: { tmuxName: "kat_a" } } });
  });

  it("load returns null when no file exists", () => {
    const store = createSessionStore({ dataDir: dir, serialize: () => ({}) });
    assert.strictEqual(store.load(), null);
  });

  it("load returns null (not a throw) on a corrupt file", () => {
    writeFileSync(join(dir, "sessions.json"), "{ truncated", "utf-8");
    const store = createSessionStore({ dataDir: dir, serialize: () => ({}) });
    assert.strictEqual(store.load(), null);
  });

  it("is a no-op without a dataDir", () => {
    const store = createSessionStore({ dataDir: null, serialize: () => ({}) });
    store.saveNow();
    assert.strictEqual(store.load(), null);
  });

  it("scheduleSave debounces and writes after the window", async () => {
    let calls = 0;
    const store = createSessionStore({
      dataDir: dir,
      serialize: () => { calls++; return { sessions: {} }; },
      debounceMs: 5,
    });

    store.scheduleSave();
    store.scheduleSave();
    store.scheduleSave();
    assert.strictEqual(calls, 0, "nothing written inside the debounce window");

    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(calls, 1, "three rapid schedules collapse into one write");
    assert.deepStrictEqual(store.load(), { sessions: {} });
  });
});
