import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, validateSession, pruneExpiredSessions, loadState, saveState, _invalidateCache, refreshSessionActivity } from "../lib/auth.js";
import { AuthState } from "../lib/auth-state.js";
import { SESSION_TTL_MS } from "../lib/constants.js";

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
  const credential = { id: "cred1", publicKey: "key1", counter: 0 };

  function makeState(sessions = {}) {
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions,
      setupTokens: [],
    });
  }

  it("returns true for a valid session", () => {
    const { token, expiry, csrfToken, lastActivityAt } = createSession();
    const state = makeState({
      [token]: { expiry, credentialId: credential.id, csrfToken, lastActivityAt },
    });
    assert.ok(validateSession(state, token));
  });

  it("returns false for missing token", () => {
    const state = makeState();
    assert.ok(!validateSession(state, "nonexistent"));
  });

  it("returns false for expired token", () => {
    const state = makeState({
      expired: { expiry: Date.now() - 1000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() - 2000 },
    });
    assert.ok(!validateSession(state, "expired"));
  });

  it("returns false for null state", () => {
    assert.ok(!validateSession(null, "anything"));
  });

  it("returns false for null token", () => {
    const state = makeState();
    assert.ok(!validateSession(state, null));
  });

  it("returns false when state has no sessions", () => {
    assert.ok(!validateSession(AuthState.empty(), "tok"));
  });

  it("returns false when session credentialId does not match any credential", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 60000, credentialId: "nonexistent-cred", csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, "tok"), "session with orphaned credentialId should be invalid");
  });

  it("returns false when session credentialId is null", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 60000, credentialId: null, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, "tok"), "session without credentialId should be invalid");
  });

  it("returns false for old-format session (plain number expiry in AuthState)", () => {
    // AuthState can hold a number-format session if constructed directly;
    // isValidSession must reject it regardless
    const state = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: { tok: Date.now() + 60000 },
      setupTokens: [],
    });
    assert.ok(!validateSession(state, "tok"), "old number-format session in AuthState should be rejected");
  });

  it("returns false for session object missing credentialId property entirely", () => {
    // { credentialId: null } has the property present (fails check 6);
    // an object without the property at all must fail check 4 ('credentialId' in session)
    const state = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: { tok: { expiry: Date.now() + 60000, csrfToken: "csrf" } },
      setupTokens: [],
    });
    assert.ok(!validateSession(state, "tok"), "session object without credentialId property should be rejected");
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
    const state = { user: null, credentials: [], sessions: {}, setupTokens: [] };
    saveState(state);

    const first = loadState();
    // Overwrite the file directly — loadState should still return the cached value
    writeFileSync(STATE_PATH, JSON.stringify({ user: { id: "changed", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] }));
    const second = loadState();

    assert.deepEqual(first.toJSON(), state);
    assert.deepEqual(second.toJSON(), state, "second call should return cached value, not re-read disk");
  });

  it("saveState updates the cache immediately", () => {
    const stateA = { user: { id: "a", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    const stateB = { user: { id: "b", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };

    saveState(stateA);
    assert.deepEqual(loadState().toJSON(), stateA);

    saveState(stateB);
    assert.deepEqual(loadState().toJSON(), stateB, "cache should reflect the latest saveState call");
  });

  it("_invalidateCache forces a re-read from disk", () => {
    const original = { user: { id: "1", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    saveState(original);
    assert.deepEqual(loadState().toJSON(), original);

    // Write different data directly to disk
    const updated = { user: { id: "2", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
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
    writeFileSync(STATE_PATH, JSON.stringify({ user: { id: "test", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] }));
    assert.equal(loadState(), null, "null should be cached too");

    _invalidateCache();
    const loaded = loadState();
    assert.ok(loaded, "should load state after invalidation");
    assert.deepEqual(loaded.toJSON(), { user: { id: "test", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] }, "after invalidation should read new file");
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
        // Old pairing session (credentialId: null - should be removed, pairing now creates credentials)
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

    // Should remove token5 (old pairing session - pairing now creates credentials)
    assert.equal(sessions.token5, undefined, "should remove old pairing sessions");
  });

  it("loadState prunes expired setup tokens and persists the change", () => {
    const now = Date.now();
    const state = {
      user: { id: "user123", name: "owner" },
      credentials: [{ id: "cred1", publicKey: "key1", counter: 1, deviceId: "dev1", name: "Device 1" }],
      sessions: {},
      setupTokens: [
        // Valid token (not expired)
        { id: "tok1", token: "validtoken", name: "Valid", createdAt: now - 1000, lastUsedAt: null, expiresAt: now + 7 * 24 * 60 * 60 * 1000 },
        // Expired token
        { id: "tok2", token: "expiredtoken", name: "Expired", createdAt: now - 20000, lastUsedAt: null, expiresAt: now - 1 },
        // Legacy token without expiresAt (fail-closed: treated as expired)
        { id: "tok3", token: "legacytoken", name: "Legacy", createdAt: now - 30000, lastUsedAt: null },
      ],
    };

    writeFileSync(STATE_PATH, JSON.stringify(state));
    _invalidateCache();

    const loaded = loadState();
    const tokens = loaded.setupTokens;

    assert.equal(tokens.length, 1, "should only keep valid non-expired token");
    assert.equal(tokens[0].id, "tok1", "should keep the valid token");
    assert.equal(tokens.find(t => t.id === "tok2"), undefined, "should remove expired token");
    assert.equal(tokens.find(t => t.id === "tok3"), undefined, "should remove legacy token without expiresAt");
  });
});

describe("loadState - corrupted state file handling", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = process.env.KATULONG_DATA_DIR || join(__dirname, "..");
  const STATE_PATH = join(DATA_DIR, "katulong-auth.json");
  let originalExists = false;
  let originalContent;

  beforeEach(() => {
    try {
      originalContent = readFileSync(STATE_PATH, "utf-8");
      originalExists = true;
    } catch {
      originalExists = false;
    }
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (originalExists) {
      writeFileSync(STATE_PATH, originalContent);
    } else {
      try { unlinkSync(STATE_PATH); } catch {}
    }
  });

  it("returns null for corrupt JSON (unparsable content)", () => {
    writeFileSync(STATE_PATH, "{ invalid json ::::");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "corrupt JSON should return null rather than throw");
  });

  it("returns null for truncated JSON", () => {
    writeFileSync(STATE_PATH, '{"user": {"id": "test"'); // truncated before closing braces
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "truncated JSON should return null");
  });

  it("returns null for empty state file", () => {
    writeFileSync(STATE_PATH, "");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "empty file should return null");
  });

  it("returns null for file containing only whitespace", () => {
    writeFileSync(STATE_PATH, "   \n  \t  ");
    _invalidateCache();
    const result = loadState();
    assert.equal(result, null, "whitespace-only file should return null");
  });

  it("can recover and load valid state after corruption is fixed", () => {
    // Write corrupt file first
    writeFileSync(STATE_PATH, "not-json");
    _invalidateCache();
    assert.equal(loadState(), null, "should be null when corrupt");

    // Now fix the file
    const validState = { user: { id: "recover", name: "owner" }, credentials: [], sessions: {}, setupTokens: [] };
    writeFileSync(STATE_PATH, JSON.stringify(validState));
    _invalidateCache();
    const result = loadState();
    assert.ok(result, "should load successfully after fixing corruption");
    assert.equal(result.user.id, "recover");
  });
});

describe("validateSession - boundary and edge cases", () => {
  const credential = { id: "cred1", publicKey: "key1", counter: 0 };

  function makeState(sessions = {}) {
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions,
      setupTokens: [],
    });
  }

  it("returns false for session expiring exactly 1ms in the past", () => {
    const state = makeState({
      tok: { expiry: Date.now() - 1, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() - 2 },
    });
    assert.ok(!validateSession(state, "tok"), "session expired 1ms ago should be invalid");
  });

  it("returns true for session expiring 1ms in the future", () => {
    const state = makeState({
      tok: { expiry: Date.now() + 1000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(validateSession(state, "tok"), "session expiring 1s from now should be valid");
  });

  it("returns false for session with expiry of 0 (epoch)", () => {
    const state = makeState({
      tok: { expiry: 0, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: 0 },
    });
    assert.ok(!validateSession(state, "tok"), "expiry of 0 (epoch) is always in the past");
  });

  it("returns false for empty-string token", () => {
    const state = makeState({
      "": { expiry: Date.now() + 60000, credentialId: credential.id, csrfToken: "csrf", lastActivityAt: Date.now() },
    });
    assert.ok(!validateSession(state, ""), "empty token should not be valid");
  });
});

describe("pruneExpiredSessions - boundary conditions", () => {
  it("removes sessions with expiry exactly equal to Date.now() - 1", () => {
    const expiry = Date.now() - 1;
    const state = { sessions: { boundaryToken: expiry } };
    const result = pruneExpiredSessions(state);
    assert.equal(result.sessions.boundaryToken, undefined, "just-expired session should be pruned");
  });

  it("keeps sessions with expiry well in the future", () => {
    const expiry = Date.now() + 1000 * 60 * 60; // 1 hour from now
    const state = { sessions: { futureToken: expiry } };
    const result = pruneExpiredSessions(state);
    assert.ok(result.sessions.futureToken, "future session should be kept");
  });

  it("handles mixed valid and expired sessions in one pass", () => {
    const now = Date.now();
    const state = {
      sessions: {
        valid1: now + 10000,
        expired1: now - 10000,
        valid2: now + 20000,
        expired2: now - 1,
      },
    };
    const result = pruneExpiredSessions(state);
    assert.ok(result.sessions.valid1, "valid1 should survive");
    assert.ok(result.sessions.valid2, "valid2 should survive");
    assert.equal(result.sessions.expired1, undefined, "expired1 should be pruned");
    assert.equal(result.sessions.expired2, undefined, "expired2 should be pruned");
    assert.equal(Object.keys(result.sessions).length, 2);
  });
});

describe("refreshSessionActivity", () => {
  const __dirname_test = dirname(fileURLToPath(import.meta.url));
  const DATA_DIR_TEST = process.env.KATULONG_DATA_DIR || join(__dirname_test, "..");
  const STATE_PATH_TEST = join(DATA_DIR_TEST, "katulong-auth.json");
  let originalExists = false;
  let originalContent;

  beforeEach(() => {
    try {
      originalContent = readFileSync(STATE_PATH_TEST, "utf-8");
      originalExists = true;
    } catch {
      originalExists = false;
    }
    _invalidateCache();
  });

  afterEach(() => {
    _invalidateCache();
    if (originalExists) {
      writeFileSync(STATE_PATH_TEST, originalContent);
    } else {
      try { unlinkSync(STATE_PATH_TEST); } catch {}
    }
  });

  const credential = { id: "cred1", publicKey: "key1", counter: 0, deviceId: "dev1", name: "Test Device" };

  function makeValidState(token, sessionOverrides = {}) {
    const now = Date.now();
    return new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {
        [token]: {
          expiry: now + 30 * 24 * 60 * 60 * 1000,
          credentialId: credential.id,
          csrfToken: "csrf1",
          lastActivityAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
          ...sessionOverrides,
        },
      },
      setupTokens: [],
    });
  }

  it("returns early for null token without calling withStateLock", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    await refreshSessionActivity(null);

    const loaded = loadState();
    assert.deepEqual(Object.keys(loaded.sessions), [], "no sessions should be added for null token");
  });

  it("returns early for undefined token without throwing", async () => {
    await assert.doesNotReject(
      () => refreshSessionActivity(undefined),
      "refreshSessionActivity should not throw for undefined token"
    );
  });

  it("updates lastActivityAt for a valid session", async () => {
    const token = "validtoken123";
    const initial = makeValidState(token);
    const originalLastActivity = initial.sessions[token].lastActivityAt;
    const beforeCall = Date.now() - 1;
    saveState(initial);

    await refreshSessionActivity(token);

    const updated = loadState();
    assert.ok(updated.sessions[token], "session should still exist after refresh");
    assert.ok(
      updated.sessions[token].lastActivityAt > originalLastActivity,
      "lastActivityAt should be updated to a more recent time"
    );
    assert.ok(
      updated.sessions[token].lastActivityAt >= beforeCall,
      "lastActivityAt should be at or after the time of the call"
    );
  });

  it("does not update lastActivityAt for an expired token", async () => {
    const token = "expiredtoken456";
    const now = Date.now();
    const initial = makeValidState(token, {
      expiry: now - 1000, // expired 1 second ago
      lastActivityAt: now - 2000,
    });
    const originalLastActivity = initial.sessions[token].lastActivityAt;
    saveState(initial);

    await refreshSessionActivity(token);

    const loaded = loadState();
    assert.equal(
      loaded.sessions[token].lastActivityAt,
      originalLastActivity,
      "expired session lastActivityAt should not be updated"
    );
  });

  it("does not modify state for a non-existent token", async () => {
    const initial = new AuthState({
      user: { id: "user1", name: "owner" },
      credentials: [credential],
      sessions: {},
      setupTokens: [],
    });
    saveState(initial);

    await refreshSessionActivity("doesnotexist");

    const loaded = loadState();
    assert.deepEqual(Object.keys(loaded.sessions), [], "no sessions should be created for unknown token");
  });

  it("is a no-op when there is no auth state (null state)", async () => {
    try { unlinkSync(STATE_PATH_TEST); } catch {}
    _invalidateCache();

    await assert.doesNotReject(
      () => refreshSessionActivity("sometoken"),
      "refreshSessionActivity should not throw when no state file exists"
    );
  });

  it("extends session expiry when lastActivityAt is more than 24h ago (sliding window)", async () => {
    const token = "oldactivitytoken";
    const now = Date.now();
    // Use a short initial expiry (10 minutes) so any sliding-window extension to 30 days is unambiguous
    const initial = makeValidState(token, {
      expiry: now + 10 * 60 * 1000, // 10 minutes from now
      lastActivityAt: now - 25 * 60 * 60 * 1000, // 25 hours ago, beyond the 24h threshold
    });
    const originalExpiry = initial.sessions[token].expiry;
    saveState(initial);

    await refreshSessionActivity(token);

    const updated = loadState();
    assert.ok(
      updated.sessions[token].expiry > originalExpiry,
      "expiry should be extended when lastActivityAt was more than 24h ago"
    );
    assert.ok(
      updated.sessions[token].expiry >= now + SESSION_TTL_MS - 1000,
      "expiry should be approximately 30 days from now"
    );
  });
});
