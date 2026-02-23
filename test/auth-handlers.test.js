import { describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { AuthState } from "../lib/auth-state.js";
import { Success, Failure } from "../lib/result.js";
// Static imports are used for failure-path tests (no mocking needed there)
import {
  processRegistration,
  processAuthentication,
  extractChallenge,
} from "../lib/auth-handlers.js";

// ─── extractChallenge ────────────────────────────────────────────────────────

describe("extractChallenge", () => {
  it("extracts challenge from WebAuthn credential", () => {
    const credential = {
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({ challenge: "test-challenge-123", origin: "https://example.com" })
        ).toString("base64url"),
      },
    };

    const challenge = extractChallenge(credential);
    assert.equal(challenge, "test-challenge-123");
  });

  it("handles different challenge values", () => {
    const credential = {
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({ challenge: "another-challenge", type: "webauthn.create" })
        ).toString("base64url"),
      },
    };

    const challenge = extractChallenge(credential);
    assert.equal(challenge, "another-challenge");
  });

  it("throws when credential.response is missing", () => {
    assert.throws(
      () => extractChallenge({}),
      (err) => err instanceof TypeError,
      "should throw TypeError when response property is absent"
    );
  });

  it("throws when clientDataJSON is not valid JSON after base64url decoding", () => {
    // Encode raw bytes that aren't valid JSON
    const credential = {
      response: {
        clientDataJSON: Buffer.from("this is not json at all!!!").toString("base64url"),
      },
    };
    assert.throws(
      () => extractChallenge(credential),
      (err) => err instanceof SyntaxError,
      "should throw SyntaxError when decoded content is not valid JSON"
    );
  });
});

// ─── processRegistration — failure paths ─────────────────────────────────────
//
// These tests use the statically-imported processRegistration. No mocking is
// needed because every failure branch returns before calling verifyRegistration.

describe("processRegistration", () => {
  it("returns Failure with reason 'invalid-challenge' and status 400 when challengeValid is false", async () => {
    const result = await processRegistration({
      credential: {},
      challenge: "test",
      challengeValid: false,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "invalid-challenge");
    assert.equal(result.statusCode, 400);
    assert.ok(result.message, "Failure should include a message");
  });

  it("returns Failure 'invalid-challenge' even when currentState already has credentials", async () => {
    const state = AuthState.empty("user123").addCredential({
      id: "cred1",
      publicKey: "key1",
      counter: 0,
    });

    const result = await processRegistration({
      credential: {},
      challenge: "test",
      challengeValid: false,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "invalid-challenge");
  });

  it("returns Failure with reason 'verification-failed' when WebAuthn verification throws", async () => {
    const result = await processRegistration({
      credential: {
        id: "cred123",
        response: {
          clientDataJSON: "invalid-data",
          attestationObject: "invalid",
        },
      },
      challenge: "test",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "verification-failed");
    assert.equal(result.statusCode, 400);
    assert.ok(result.message, "Failure should include error details from the thrown exception");
  });
});

// ─── processAuthentication — failure paths ────────────────────────────────────
//
// Same pattern: all failure branches return before calling verifyAuth.

describe("processAuthentication", () => {
  it("returns Failure with reason 'not-setup' when currentState is null", async () => {
    const result = await processAuthentication({
      credential: {},
      challenge: "test",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "not-setup");
    assert.equal(result.statusCode, 400);
  });

  it("returns Failure with reason 'unknown-credential' when credential ID is absent from state", async () => {
    const state = AuthState.empty("user123").addCredential({
      id: "known-cred",
      publicKey: "key",
      counter: 0,
    });

    const result = await processAuthentication({
      credential: { id: "unknown-cred" },
      challenge: "test",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "unknown-credential");
  });

  it("checks credential existence before challenge validity", async () => {
    // unknown-credential should be returned even when challengeValid is false,
    // because the credential lookup (step 2) precedes the challenge check (step 3)
    const state = AuthState.empty("user123").addCredential({
      id: "known-cred",
      publicKey: "key",
      counter: 0,
    });

    const result = await processAuthentication({
      credential: { id: "unknown-cred" },
      challenge: "test",
      challengeValid: false,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Failure);
    assert.equal(
      result.reason,
      "unknown-credential",
      "credential lookup must fail before challenge is checked"
    );
  });

  it("returns Failure with reason 'invalid-challenge' when challengeValid is false and credential exists", async () => {
    const state = AuthState.empty("user123").addCredential({
      id: "cred123",
      publicKey: "key",
      counter: 0,
    });

    const result = await processAuthentication({
      credential: { id: "cred123" },
      challenge: "test",
      challengeValid: false,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "invalid-challenge");
    assert.equal(result.statusCode, 400);
  });

  it("returns Failure with reason 'verification-failed' when WebAuthn verification throws", async () => {
    const state = AuthState.empty("user123").addCredential({
      id: "cred123",
      publicKey: "key",
      counter: 0,
    });

    const result = await processAuthentication({
      credential: {
        id: "cred123",
        response: {
          clientDataJSON: "invalid-data",
        },
      },
      challenge: "test",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "verification-failed");
    assert.equal(result.statusCode, 400);
    assert.ok(result.message, "Failure should include the error message from the thrown exception");
  });
});

// ─── processRegistration — success path (mocked WebAuthn) ────────────────────
//
// mock.module() is called before the module is dynamically imported so the
// fresh auth-handlers.js instance sees the mocked auth.js exports.

describe("processRegistration — success path", () => {
  let processRegistrationMocked;

  // What the mocked verifyRegistration returns
  const MOCK_CRED = { id: "mock-cred-id", publicKey: "bW9ja3B1YmtleQ", counter: 0 };

  before(async () => {
    const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;
    mock.module(authModuleUrl, {
      namedExports: {
        // Return a fixed credential so we can assert the exact state mutation
        verifyRegistration: async () => ({ ...MOCK_CRED }),
        // Unused in registration path, provided to satisfy the import
        verifyAuth: async () => 0,
        // Return a deterministic session so we can look it up in the state
        createSession: () => ({
          token: "mock-session-token",
          csrfToken: "mock-csrf-token",
          expiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
          lastActivityAt: Date.now(),
        }),
      },
    });
    // Cache-busted URL creates a fresh module instance that sees the mocked auth.js
    const mod = await import("../lib/auth-handlers.js?mock=registration");
    processRegistrationMocked = mod.processRegistration;
  });

  after(() => mock.reset());

  it("returns Success and stores the new credential in state (first device)", async () => {
    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
    });

    assert.ok(result instanceof Success, "should return a Success result");
    const { session, updatedState, credentialId } = result.data;

    // AuthState contains the new credential
    assert.ok(updatedState instanceof AuthState, "updatedState should be an AuthState instance");
    assert.equal(updatedState.credentials.length, 1, "state should have exactly one credential");
    assert.equal(updatedState.credentials[0].id, MOCK_CRED.id, "credential id should match verifyRegistration output");
    assert.equal(credentialId, MOCK_CRED.id, "credentialId in result.data should match");

    // Session is stored in state and linked to the new credential
    assert.ok(session.token, "result should include a session with a token");
    const storedSession = updatedState.sessions[session.token];
    assert.ok(storedSession, "session should be persisted inside updatedState");
    assert.equal(storedSession.credentialId, MOCK_CRED.id, "session must be linked to the registered credential");
    assert.ok(storedSession.csrfToken, "session should carry a CSRF token");
    assert.ok(storedSession.expiry > Date.now(), "session expiry should be in the future");
  });

  it("preserves existing credentials when registering a second device", async () => {
    const existingCred = { id: "existing-cred-id", publicKey: "existingkey", counter: 0 };
    const existingState = AuthState.empty("user123").addCredential(existingCred);

    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: existingState,
    });

    assert.ok(result instanceof Success);
    const { updatedState } = result.data;

    assert.equal(updatedState.credentials.length, 2, "both old and new credentials should be in state");
    assert.ok(
      updatedState.credentials.find((c) => c.id === "existing-cred-id"),
      "existing credential must be preserved"
    );
    assert.ok(
      updatedState.credentials.find((c) => c.id === MOCK_CRED.id),
      "newly registered credential must be present"
    );
  });

  it("enriches credential with device metadata from registration params", async () => {
    const before = Date.now();

    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
      deviceId: "device-uuid-abc",
      deviceName: "My MacBook Pro",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });

    assert.ok(result instanceof Success);
    const cred = result.data.updatedState.credentials[0];

    assert.equal(cred.deviceId, "device-uuid-abc", "deviceId should be stored on the credential");
    assert.equal(cred.name, "My MacBook Pro", "device name should be stored on the credential");
    assert.equal(
      cred.userAgent,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      "userAgent should be stored on the credential"
    );
    assert.ok(cred.createdAt >= before, "createdAt should be set to approximately current time");
    assert.ok(cred.lastUsedAt >= before, "lastUsedAt should be set to approximately current time");
  });

  it("defaults credential name to 'Unknown Device' when deviceName is not provided", async () => {
    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
      // No deviceName or deviceId
    });

    assert.ok(result instanceof Success);
    const cred = result.data.updatedState.credentials[0];
    assert.equal(cred.name, "Unknown Device", "name should default to 'Unknown Device'");
    assert.equal(cred.deviceId, null, "deviceId should be null when not provided");
    assert.equal(cred.userAgent, "Unknown", "userAgent should default to 'Unknown'");
  });

  it("stores setupTokenId on credential when provided", async () => {
    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
      setupTokenId: "tok-id-xyz-987",
    });

    assert.ok(result instanceof Success);
    const cred = result.data.updatedState.credentials[0];
    assert.equal(cred.setupTokenId, "tok-id-xyz-987", "setupTokenId should link credential to the setup token used");
  });

  it("sets setupTokenId to null when no setup token was used", async () => {
    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: null,
      // No setupTokenId
    });

    assert.ok(result instanceof Success);
    const cred = result.data.updatedState.credentials[0];
    assert.equal(cred.setupTokenId, null, "setupTokenId should be null for first-device registrations");
  });

  it("prunes expired sessions from currentState before building updatedState", async () => {
    // Build a state with one valid and one expired session
    const expiredToken = "expired-tok";
    const existingCred = { id: "cred-xyz", publicKey: "key", counter: 0 };
    const stateWithExpired = new AuthState({
      user: { id: "user123", name: "owner" },
      credentials: [existingCred],
      sessions: {
        [expiredToken]: { expiry: Date.now() - 1000, credentialId: "cred-xyz", csrfToken: "x", lastActivityAt: Date.now() - 2000 },
      },
      setupTokens: [],
    });

    const result = await processRegistrationMocked({
      credential: {},
      challenge: "test-challenge",
      challengeValid: true,
      userID: "user123",
      origin: "https://example.com",
      rpID: "example.com",
      currentState: stateWithExpired,
    });

    assert.ok(result instanceof Success);
    const { updatedState } = result.data;
    assert.equal(
      updatedState.sessions[expiredToken],
      undefined,
      "expired session should be pruned from updatedState"
    );
  });
});

// ─── processAuthentication — success path (mocked WebAuthn) ──────────────────

describe("processAuthentication — success path", () => {
  let processAuthenticationMocked;

  // Counter value that the mocked verifyAuth returns
  const NEW_COUNTER = 7;

  before(async () => {
    const authModuleUrl = new URL("../lib/auth.js", import.meta.url).href;
    mock.module(authModuleUrl, {
      namedExports: {
        // Unused in authentication path, provided to satisfy the import
        verifyRegistration: async () => ({}),
        // Return a fixed counter increment
        verifyAuth: async () => NEW_COUNTER,
        // Return a deterministic session so we can look it up in state
        createSession: () => ({
          token: "auth-session-token",
          csrfToken: "auth-csrf-token",
          expiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
          lastActivityAt: Date.now(),
        }),
      },
    });
    // Different cache-bust key than the registration tests
    const mod = await import("../lib/auth-handlers.js?mock=authentication");
    processAuthenticationMocked = mod.processAuthentication;
  });

  after(() => mock.reset());

  it("returns Success with counter updated and session created in state", async () => {
    const existingCred = { id: "cred123", publicKey: "pubkey", counter: 2 };
    const state = AuthState.empty("user123").addCredential(existingCred);

    const result = await processAuthenticationMocked({
      credential: { id: "cred123" },
      challenge: "test-challenge",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Success, "should return a Success result");
    const { session, updatedState } = result.data;

    // Counter is updated to the value returned by verifyAuth
    const updatedCred = updatedState.credentials.find((c) => c.id === "cred123");
    assert.ok(updatedCred, "authenticated credential should still be present in state");
    assert.equal(updatedCred.counter, NEW_COUNTER, "counter should be updated to the value from verifyAuth");

    // Session is stored and linked to the credential that was authenticated
    assert.ok(session.token, "result should contain a session with a token");
    const storedSession = updatedState.sessions[session.token];
    assert.ok(storedSession, "session should be stored in the updated state");
    assert.equal(
      storedSession.credentialId,
      "cred123",
      "session should be linked to the credential that performed authentication"
    );
    assert.ok(storedSession.csrfToken, "session should carry a CSRF token");
    assert.ok(storedSession.expiry > Date.now(), "session expiry should be in the future");
  });

  it("preserves all other credentials in state after authentication", async () => {
    const state = AuthState.empty("user123")
      .addCredential({ id: "cred1", publicKey: "key1", counter: 0 })
      .addCredential({ id: "cred2", publicKey: "key2", counter: 0 });

    const result = await processAuthenticationMocked({
      credential: { id: "cred1" },
      challenge: "test-challenge",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Success);
    const { updatedState } = result.data;

    assert.equal(updatedState.credentials.length, 2, "all credentials should survive authentication");
    assert.ok(updatedState.credentials.find((c) => c.id === "cred1"), "cred1 should still exist");
    assert.ok(updatedState.credentials.find((c) => c.id === "cred2"), "cred2 should still exist");
  });

  it("updates lastUsedAt on the authenticated credential", async () => {
    const before = Date.now();
    const state = AuthState.empty("user123").addCredential({
      id: "cred123",
      publicKey: "pubkey",
      counter: 0,
      lastUsedAt: before - 100_000,
    });

    const result = await processAuthenticationMocked({
      credential: { id: "cred123" },
      challenge: "test-challenge",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: state,
    });

    assert.ok(result instanceof Success);
    const cred = result.data.updatedState.credentials.find((c) => c.id === "cred123");
    assert.ok(cred.lastUsedAt >= before, "lastUsedAt should be updated to approximately current time");
  });

  it("prunes expired sessions from currentState before building updatedState", async () => {
    const expiredToken = "expired-auth-tok";
    const existingCred = { id: "cred123", publicKey: "pubkey", counter: 0 };
    const stateWithExpired = new AuthState({
      user: { id: "user123", name: "owner" },
      credentials: [existingCred],
      sessions: {
        [expiredToken]: { expiry: Date.now() - 1000, credentialId: "cred123", csrfToken: "x", lastActivityAt: Date.now() - 2000 },
      },
      setupTokens: [],
    });

    const result = await processAuthenticationMocked({
      credential: { id: "cred123" },
      challenge: "test-challenge",
      challengeValid: true,
      origin: "https://example.com",
      rpID: "example.com",
      currentState: stateWithExpired,
    });

    assert.ok(result instanceof Success);
    const { updatedState } = result.data;
    assert.equal(
      updatedState.sessions[expiredToken],
      undefined,
      "expired session should be pruned from updatedState"
    );
  });
});

// ─── Result types (sanity checks) ────────────────────────────────────────────

describe("Success", () => {
  it("creates success result with session and updatedState", () => {
    const session = { token: "abc123", expiry: Date.now() + 10000 };
    const state = AuthState.empty("user123");

    const result = new Success({ session, updatedState: state });

    assert.equal(result.success, true);
    assert.deepEqual(result.data.session, session);
    assert.equal(result.data.updatedState, state);
  });
});

describe("Failure", () => {
  it("creates failure result with reason, message, and status code", () => {
    const result = new Failure("test-reason", "Test message", 400);

    assert.equal(result.success, false);
    assert.equal(result.reason, "test-reason");
    assert.equal(result.message, "Test message");
    assert.equal(result.statusCode, 400);
  });

  it("defaults status code to 400", () => {
    const result = new Failure("test-reason", "Test message");

    assert.equal(result.statusCode, 400);
  });
});
