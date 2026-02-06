import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, validateSession, pruneExpiredSessions, loadState, saveState, _invalidateCache } from "../lib/auth.js";

describe("createSession", () => {
  it("returns a token that is 64 hex characters", () => {
    const { token } = createSession();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it("returns an expiry roughly 30 days in the future", () => {
    const { expiry } = createSession();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const diff = expiry - Date.now();
    // Allow 5 second tolerance
    assert.ok(diff > thirtyDays - 5000, `expiry too early: ${diff}ms`);
    assert.ok(diff <= thirtyDays, `expiry too late: ${diff}ms`);
  });

  it("generates unique tokens", () => {
    const a = createSession();
    const b = createSession();
    assert.notEqual(a.token, b.token);
  });
});

describe("validateSession", () => {
  it("returns true for a valid session", () => {
    const { token, expiry } = createSession();
    const state = { sessions: { [token]: expiry } };
    assert.ok(validateSession(state, token));
  });

  it("returns false for missing token", () => {
    const state = { sessions: {} };
    assert.ok(!validateSession(state, "nonexistent"));
  });

  it("returns false for expired token", () => {
    const state = { sessions: { expired: Date.now() - 1000 } };
    assert.ok(!validateSession(state, "expired"));
  });

  it("returns false for null state", () => {
    assert.ok(!validateSession(null, "anything"));
  });

  it("returns false for null token", () => {
    const state = { sessions: {} };
    assert.ok(!validateSession(state, null));
  });

  it("returns false when state has no sessions", () => {
    assert.ok(!validateSession({}, "tok"));
  });
});

describe("pruneExpiredSessions", () => {
  it("removes expired sessions", () => {
    const state = {
      sessions: {
        expired1: Date.now() - 10000,
        expired2: Date.now() - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result.sessions, {});
  });

  it("keeps valid sessions", () => {
    const future = Date.now() + 60000;
    const state = {
      sessions: {
        valid: future,
        expired: Date.now() - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(Object.keys(result.sessions), ["valid"]);
    assert.equal(result.sessions.valid, future);
  });

  it("handles empty sessions object", () => {
    const state = { sessions: {} };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result.sessions, {});
  });

  it("handles state without sessions key", () => {
    const state = { user: "test" };
    const result = pruneExpiredSessions(state);
    assert.deepEqual(result, { user: "test" });
  });

  it("handles null state", () => {
    const result = pruneExpiredSessions(null);
    assert.equal(result, null);
  });
});

describe("loadState caching", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = process.env.KATULONG_DATA_DIR || join(__dirname, "..");
  const STATE_PATH = join(DATA_DIR, "katulong-auth.json");
  let originalExists = false;
  let originalContent;

  beforeEach(() => {
    // Back up existing state file if present
    try {
      originalContent = require("node:fs").readFileSync(STATE_PATH, "utf-8");
      originalExists = true;
    } catch {
      originalExists = false;
    }
    _invalidateCache();
  });

  afterEach(() => {
    // Restore original state
    _invalidateCache();
    if (originalExists) {
      writeFileSync(STATE_PATH, originalContent);
    } else {
      try { unlinkSync(STATE_PATH); } catch {}
    }
  });

  it("returns cached value on second call without re-reading disk", () => {
    const state = { credentials: [], sessions: {}, test: true };
    saveState(state);

    const first = loadState();
    // Overwrite the file directly — loadState should still return the cached value
    writeFileSync(STATE_PATH, JSON.stringify({ overwritten: true }));
    const second = loadState();

    assert.deepEqual(first, state);
    assert.deepEqual(second, state, "second call should return cached value, not re-read disk");
  });

  it("saveState updates the cache immediately", () => {
    const stateA = { credentials: [], sessions: {}, version: "a" };
    const stateB = { credentials: [], sessions: {}, version: "b" };

    saveState(stateA);
    assert.deepEqual(loadState(), stateA);

    saveState(stateB);
    assert.deepEqual(loadState(), stateB, "cache should reflect the latest saveState call");
  });

  it("_invalidateCache forces a re-read from disk", () => {
    const original = { credentials: [], sessions: {}, v: 1 };
    saveState(original);
    assert.deepEqual(loadState(), original);

    // Write different data directly to disk
    const updated = { credentials: [], sessions: {}, v: 2 };
    writeFileSync(STATE_PATH, JSON.stringify(updated));

    // Cache still holds old value
    assert.deepEqual(loadState(), original);

    // After invalidation, it re-reads from disk
    _invalidateCache();
    assert.deepEqual(loadState(), updated, "should re-read from disk after cache invalidation");
  });

  it("loadState returns null and caches it when file does not exist", () => {
    try { unlinkSync(STATE_PATH); } catch {}
    _invalidateCache();

    assert.equal(loadState(), null);
    // Write a file — but cache should still return null
    writeFileSync(STATE_PATH, JSON.stringify({ surprise: true }));
    assert.equal(loadState(), null, "null should be cached too");

    _invalidateCache();
    assert.deepEqual(loadState(), { surprise: true }, "after invalidation should read new file");
  });
});
