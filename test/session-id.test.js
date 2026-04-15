/**
 * Session surrogate-id tests (MC1e PR1 — additive server-side id).
 *
 * These assertions are load-bearing for the later MC1e steps that migrate
 * client stores to key by id. If any of them regress, the client-side work
 * can't rely on id being present/stable/persisted.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sessionId, SESSION_ID_PATTERN } from "../lib/id.js";
import {
  setupSessionManagerMocks,
  BaseMockSession,
  makeBridge,
  tmuxSessions,
} from "./helpers/session-manager-fixture.js";

const { createSessionManager } = await setupSessionManagerMocks(BaseMockSession);

function makeManager(overrides = {}) {
  return createSessionManager({
    bridge: makeBridge(),
    shell: "/bin/sh",
    home: "/tmp",
    ...overrides,
  });
}

describe("sessionId()", () => {
  it("returns a 21-char url-safe id by default", () => {
    const id = sessionId();
    assert.strictEqual(id.length, 21);
    assert.match(id, SESSION_ID_PATTERN);
  });

  it("generates distinct ids across many calls", () => {
    const ids = new Set();
    for (let i = 0; i < 10000; i++) ids.add(sessionId());
    assert.strictEqual(ids.size, 10000, "10k sessionIds should all be unique");
  });

  it("supports a custom size", () => {
    assert.strictEqual(sessionId(5).length, 5);
    assert.strictEqual(sessionId(40).length, 40);
  });
});

describe("session manager — id lifecycle", () => {
  beforeEach(() => {
    tmuxSessions.clear();
  });

  it("createSession generates an id", async () => {
    const mgr = makeManager();
    const result = await mgr.createSession("s1");
    assert.match(result.id, SESSION_ID_PATTERN);
  });

  it("listSessions surfaces the id", async () => {
    const mgr = makeManager();
    const { id } = await mgr.createSession("s1");
    const { sessions } = mgr.listSessions();
    assert.strictEqual(sessions[0].id, id);
  });

  it("renameSession preserves the id", async () => {
    const mgr = makeManager();
    const { id } = await mgr.createSession("original");
    const renamed = await mgr.renameSession("original", "updated");
    assert.strictEqual(renamed.id, id, "id must not change on rename");
    const { sessions } = mgr.listSessions();
    assert.strictEqual(sessions[0].id, id);
  });

  it("ids are distinct across concurrently-created sessions", async () => {
    const mgr = makeManager();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => mgr.createSession(`s${i}`)),
    );
    const ids = new Set(results.map(r => r.id));
    assert.strictEqual(ids.size, 8);
  });

  it("session-renamed relay carries the id", async () => {
    const bridge = makeBridge();
    const mgr = createSessionManager({ bridge, shell: "/bin/sh", home: "/tmp" });
    const { id } = await mgr.createSession("a");
    await mgr.renameSession("a", "b");
    const renamed = bridge.messages.find(m => m.type === "session-renamed");
    assert.strictEqual(renamed.id, id);
  });
});

describe("session manager — id persistence", () => {
  let dataDir;

  beforeEach(() => {
    tmuxSessions.clear();
    dataDir = mkdtempSync(join(tmpdir(), "katulong-id-test-"));
  });

  it("persists id to sessions.json", async () => {
    const mgr = makeManager({ dataDir });
    const { id } = await mgr.createSession("persisted");
    mgr.shutdown();
    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    assert.strictEqual(saved["persisted"].id, id);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("restores the id across a fresh manager", async () => {
    const mgr1 = makeManager({ dataDir });
    const { id } = await mgr1.createSession("keep-me");
    mgr1.shutdown();
    // tmux session still alive (real shutdown detaches; our mock kept it)
    tmuxSessions.set("keep-me", true);

    const mgr2 = makeManager({ dataDir });
    await mgr2.restoreSessions();
    const restored = mgr2.listSessions().sessions.find(s => s.name === "keep-me");
    assert.ok(restored, "session should restore");
    assert.strictEqual(restored.id, id, "restored id must match persisted id");
    mgr2.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("accepts legacy string-valued sessions.json and synthesizes ids", async () => {
    // Pre-MC1e shape: { name: "tmuxName" } with no id.
    writeFileSync(
      join(dataDir, "sessions.json"),
      JSON.stringify({ "legacy-session": "legacy_session" }),
    );
    tmuxSessions.set("legacy_session", true);

    const mgr = makeManager({ dataDir });
    await mgr.restoreSessions();
    const restored = mgr.listSessions().sessions.find(s => s.name === "legacy-session");
    assert.ok(restored, "legacy-format session should restore");
    assert.match(restored.id, SESSION_ID_PATTERN, "legacy entries should get a fresh nanoid");
    mgr.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
