import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AuthState } from "../lib/auth-state.js";
import { SCOPE_FULL, SCOPE_MINT_SESSION, DEFAULT_API_KEY_SCOPES } from "../lib/api-key-scopes.js";

describe("API key scopes on AuthState", () => {
  it("addApiKey defaults to ['full'] when scopes omitted", () => {
    const state = AuthState.empty();
    const next = state.addApiKey({
      id: "k1",
      key: "x".repeat(64),
      name: "default",
      createdAt: 1,
      lastUsedAt: 0,
    });
    assert.deepEqual(next.apiKeys[0].scopes, [...DEFAULT_API_KEY_SCOPES]);
  });

  it("addApiKey persists explicitly provided scopes", () => {
    const state = AuthState.empty();
    const next = state.addApiKey({
      id: "k1",
      key: "x".repeat(64),
      name: "narrow",
      createdAt: 1,
      lastUsedAt: 0,
      scopes: [SCOPE_MINT_SESSION],
    });
    assert.deepEqual(next.apiKeys[0].scopes, [SCOPE_MINT_SESSION]);
  });

  it("addApiKey drops unknown scope strings (closed set)", () => {
    const state = AuthState.empty();
    const next = state.addApiKey({
      id: "k1",
      key: "x".repeat(64),
      name: "bogus",
      createdAt: 1,
      lastUsedAt: 0,
      scopes: ["definitely-not-real", SCOPE_MINT_SESSION],
    });
    assert.deepEqual(next.apiKeys[0].scopes, [SCOPE_MINT_SESSION]);
  });

  it("addApiKey falls back to default when all scopes are unknown", () => {
    const state = AuthState.empty();
    const next = state.addApiKey({
      id: "k1",
      key: "x".repeat(64),
      name: "all-bogus",
      createdAt: 1,
      lastUsedAt: 0,
      scopes: ["foo", "bar"],
    });
    assert.deepEqual(next.apiKeys[0].scopes, [...DEFAULT_API_KEY_SCOPES]);
  });

  it("addApiKey dedupes duplicate scopes", () => {
    const state = AuthState.empty();
    const next = state.addApiKey({
      id: "k1",
      key: "x".repeat(64),
      name: "dup",
      createdAt: 1,
      lastUsedAt: 0,
      scopes: [SCOPE_MINT_SESSION, SCOPE_MINT_SESSION, SCOPE_FULL],
    });
    assert.deepEqual(next.apiKeys[0].scopes.sort(), [SCOPE_FULL, SCOPE_MINT_SESSION].sort());
  });

  it("findApiKey returns record with scopes populated", () => {
    const key = "y".repeat(64);
    const state = AuthState.empty().addApiKey({
      id: "k1",
      key,
      name: "t",
      createdAt: 1,
      lastUsedAt: 0,
      scopes: [SCOPE_MINT_SESSION],
    });
    const found = state.findApiKey(key);
    assert.ok(found, "key should be found");
    assert.deepEqual(found.scopes, [SCOPE_MINT_SESSION]);
  });

  it("findApiKey backfills ['full'] for legacy records without scopes", () => {
    // Simulate a record persisted before the scopes field existed by
    // constructing AuthState directly (bypassing addApiKey's normalization).
    const key = "z".repeat(64);
    // First add the key normally to get a valid hash/salt/prefix shape...
    const populated = AuthState.empty().addApiKey({
      id: "legacy",
      key,
      name: "legacy",
      createdAt: 1,
      lastUsedAt: 0,
    });
    // ...then strip the scopes field to mimic an on-disk legacy record.
    const legacyRecord = { ...populated.apiKeys[0] };
    delete legacyRecord.scopes;
    const state = new AuthState({
      user: populated.user,
      credentials: populated.credentials,
      loginTokens: populated.loginTokens,
      setupTokens: populated.setupTokens,
      apiKeys: [legacyRecord],
    });
    const found = state.findApiKey(key);
    assert.ok(found, "legacy key should still be findable");
    assert.deepEqual(found.scopes, [...DEFAULT_API_KEY_SCOPES]);
  });
});
