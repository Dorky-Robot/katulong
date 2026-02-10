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
    const state = { user: null, credentials: [], sessions: {} };
    saveState(state);

    const first = loadState();
    // Overwrite the file directly — loadState should still return the cached value
    writeFileSync(STATE_PATH, JSON.stringify({ user: { id: "changed", name: "owner" }, credentials: [], sessions: {} }));
    const second = loadState();

    assert.deepEqual(first.toJSON(), state);
    assert.deepEqual(second.toJSON(), state, "second call should return cached value, not re-read disk");
  });

  it("saveState updates the cache immediately", () => {
    const stateA = { user: { id: "a", name: "owner" }, credentials: [], sessions: {} };
    const stateB = { user: { id: "b", name: "owner" }, credentials: [], sessions: {} };

    saveState(stateA);
    assert.deepEqual(loadState().toJSON(), stateA);

    saveState(stateB);
    assert.deepEqual(loadState().toJSON(), stateB, "cache should reflect the latest saveState call");
  });

  it("_invalidateCache forces a re-read from disk", () => {
    const original = { user: { id: "1", name: "owner" }, credentials: [], sessions: {} };
    saveState(original);
    assert.deepEqual(loadState().toJSON(), original);

    // Write different data directly to disk
    const updated = { user: { id: "2", name: "owner" }, credentials: [], sessions: {} };
    writeFileSync(STATE_PATH, JSON.stringify(updated));

    // Cache still holds old value
    assert.deepEqual(loadState().toJSON(), original);

    // After invalidation, it re-reads from disk
    _invalidateCache();
    assert.deepEqual(loadState().toJSON(), updated, "should re-read from disk after cache invalidation");
  });

  it("loadState returns null and caches it when file does not exist", () => {
    try { unlinkSync(STATE_PATH); } catch {}
    _invalidateCache();

    assert.equal(loadState(), null);
    // Write a file — but cache should still return null
    writeFileSync(STATE_PATH, JSON.stringify({ user: { id: "test", name: "owner" }, credentials: [], sessions: {} }));
    assert.equal(loadState(), null, "null should be cached too");

    _invalidateCache();
    const loaded = loadState();
    assert.ok(loaded, "should load state after invalidation");
    assert.deepEqual(loaded.toJSON(), { user: { id: "test", name: "owner" }, credentials: [], sessions: {} }, "after invalidation should read new file");
  });

  it("loadState migrates and cleans up orphaned sessions", () => {
    const now = Date.now();
    const state = {
      user: { id: "user123", name: "owner" },
      credentials: [
        { id: "cred1", publicKey: "key1", counter: 1, deviceId: "dev1", name: "Device 1" },
        { id: "cred2", publicKey: "key2", counter: 1, deviceId: "dev2", name: "Device 2" }
      ],
      sessions: {
        // Valid session for existing credential
        "token1": { expiry: now + 10000, credentialId: "cred1" },
        // Orphaned session for removed credential
        "token2": { expiry: now + 10000, credentialId: "cred999" },
        // Old format session (should be removed)
        "token3": now + 10000,
        // Old object format without credentialId property (should be removed)
        "token4": { expiry: now + 10000 },
        // Pairing session (credentialId: null - should be kept)
        "token5": { expiry: now + 10000, credentialId: null }
      }
    };

    writeFileSync(STATE_PATH, JSON.stringify(state));
    _invalidateCache();

    const loaded = loadState();
    const sessions = loaded.sessions;

    // Should keep token1 (valid credential)
    assert.ok(sessions.token1, "should keep session for existing credential");
    assert.equal(sessions.token1.credentialId, "cred1");

    // Should remove token2 (orphaned - credential doesn't exist)
    assert.equal(sessions.token2, undefined, "should remove session for non-existent credential");

    // Should remove token3 (old format - number)
    assert.equal(sessions.token3, undefined, "should remove old format sessions");

    // Should remove token4 (old format - missing credentialId property)
    assert.equal(sessions.token4, undefined, "should remove old object format sessions");

    // Should keep token5 (pairing session with credentialId: null)
    assert.ok(sessions.token5, "should keep pairing sessions");
    assert.equal(sessions.token5.credentialId, null);
  });
});
