/**
 * Authentication routes
 *
 * WebAuthn registration/login, credential management, API keys, setup
 * tokens, and the device-to-device auth flow (phone ↔ desktop approval).
 *
 * Extracted from lib/routes.js (Tier 3.4). The device-to-device auth
 * state is module-local and scoped to the lifetime of the process —
 * it's ephemeral by design (5-minute TTL, never persisted).
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  loadState, isSetup, withStateLock,
  generateRegistrationOpts,
  generateAuthOpts,
  createLoginToken,
} from "../auth.js";
import {
  parseCookies, setSessionCookie, getOriginAndRpID,
  isAllowedCorsOrigin, isHttpsConnection,
} from "../http-util.js";
import { isLocalRequest, getAccessMethod } from "../access-method.js";
import { processRegistration, processAuthentication, extractChallenge } from "../auth-handlers.js";
import { AuthState, LastCredentialError } from "../auth-state.js";
import {
  DEFAULT_API_KEY_SCOPES,
  SCOPE_MINT_SESSION,
  validateScopes,
} from "../api-key-scopes.js";
import { SETUP_TOKEN_TTL_MS } from "../env-config.js";
import { log } from "../log.js";

// --- Device-to-device auth (ephemeral, in-memory only) ---
//
// The approving device (desktop) receives a bridge event, displays the
// code, and calls /auth/device-auth/approve. The requesting device
// (phone) polls /auth/device-auth/status and receives a session cookie
// once approved. Requests expire after 5 minutes regardless of polling.

const deviceAuthRequests = new Map(); // requestId -> { code, userAgent, createdAt, approved, sessionToken, credentialId }
const DEVICE_AUTH_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isDeviceAuthExpired(request) {
  return Date.now() - request.createdAt > DEVICE_AUTH_TTL_MS;
}

// --- Session minting (ephemeral, in-memory only) ---
//
// A Bearer key with the "mint-session" scope can POST /api/sessions/mint
// to get back a single-use consume URL. A browser then GETs that URL
// (same-origin) and receives a first-party session cookie via 302. This is
// how the fleet hub grants a user a real session on peer katulong instances
// without forwarding the user's passkey or breaking cookie scope.
//
// The pending entry is claimed atomically via Map.delete(): if delete
// returns true, we own the single-use ticket and can materialize a session.
// Entries expire in MINT_DEFAULT_TTL_MS (configurable per-mint up to max).

const pendingMints = new Map(); // consumeToken -> { credentialId, returnTo, expiresAt, apiKeyId }
const MINT_DEFAULT_TTL_MS = 30 * 1000;
const MINT_MAX_TTL_MS = 5 * 60 * 1000;

function sweepExpiredMints(now = Date.now()) {
  for (const [token, entry] of pendingMints) {
    if (now >= entry.expiresAt) pendingMints.delete(token);
  }
}

// Background sweep so expired mints don't accumulate if never consumed.
// Unref()d so it never prevents process exit.
const mintSweepTimer = setInterval(sweepExpiredMints, MINT_DEFAULT_TTL_MS);
mintSweepTimer.unref();

// Test-only exports — guarded by NODE_ENV so a plugin or later-loaded
// module can't reach them in production and tamper with pending mints.
// `katulong test` and the unit test harness set NODE_ENV=test; production
// startup leaves it unset or at "production".
const IS_TEST_ENV = process.env.NODE_ENV === "test";

export function _resetMintForTesting() {
  if (!IS_TEST_ENV) throw new Error("_resetMintForTesting is test-only");
  pendingMints.clear();
}

export function _expireMintForTesting(token) {
  if (!IS_TEST_ENV) throw new Error("_expireMintForTesting is test-only");
  const entry = pendingMints.get(token);
  if (entry) pendingMints.set(token, { ...entry, expiresAt: Date.now() - 1 });
}

export function createAuthRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated,
    storeChallenge, consumeChallenge, challengeStore,
    credentialLockout, bridge,
    RP_NAME, PORT,
    auth, csrf, requireScope, requireBearerAuth,
  } = ctx;

  // Upper bound on the accepted length of the consume-token query param.
  // `consumeToken` is 64 hex chars; anything materially longer is garbage
  // and should be rejected before a Map lookup with a megabyte-sized key.
  const MAX_CONSUME_TOKEN_LEN = 128;

  return [
    // --- Auth status ---

    { method: "GET", path: "/auth/status", handler: (req, res) => {
      const origin = req.headers.origin;
      if (origin) {
        const { origin: serverOrigin } = getOriginAndRpID(req);
        if (isAllowedCorsOrigin(origin, serverOrigin, PORT)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Credentials", "true");
        }
      }
      const accessMethod = getAccessMethod(req);
      json(res, 200, { setup: isSetup(), accessMethod });
    }},

    // --- Registration ---

    { method: "POST", path: "/auth/register/options", rateLimit: true, handler: async (req, res) => {
      const { setupToken } = await parseJSON(req);

      let state = loadState();
      if (!state) {
        const firstTimeResult = await withStateLock((currentState) => {
          if (currentState) return { state: currentState };
          const newState = AuthState.empty();
          log.info("First time setup - empty state created");
          return { state: newState };
        });
        state = firstTimeResult.state;
      }

      const isFirstRegistration = !isSetup();
      const isLocal = isLocalRequest(req);

      if (isFirstRegistration && isLocal) {
        log.info("First passkey registration from localhost - no token required");
      } else {
        const tokenData = state.findSetupToken(setupToken);
        if (!tokenData) {
          return json(res, 403, { error: "Invalid setup token" });
        }
        await withStateLock((currentState) => {
          return { state: currentState.updateSetupToken(tokenData.id, { lastUsedAt: Date.now() }) };
        });
      }

      const { rpID } = getOriginAndRpID(req);
      let opts, userID;
      if (isSetup()) {
        if (state.user && state.user.id) {
          ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, state.user.id));
        } else {
          ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID));
        }
      } else {
        ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID));
      }
      storeChallenge(opts.challenge);
      challengeStore.setMeta(opts.challenge, "userID", userID);
      json(res, 200, opts);
    }},

    { method: "POST", path: "/auth/register/verify", rateLimit: true, handler: async (req, res) => {
      const { credential, setupToken, deviceId, deviceName, userAgent: clientUserAgent } = await parseJSON(req);
      const { origin, rpID } = getOriginAndRpID(req);

      const challenge = extractChallenge(credential);
      const challengeValid = consumeChallenge(challenge);

      const userID = challengeStore.getMeta(challenge, "userID");
      challengeStore.deleteMeta(challenge, "userID");

      const userAgent = clientUserAgent || req.headers['user-agent'] || 'Unknown';

      const result = await withStateLock(async (currentState) => {
        let setupTokenId = null;
        if (setupToken) {
          const tokenData = currentState?.findSetupToken(setupToken);
          if (!tokenData) {
            return { result: { success: false, statusCode: 403, message: "Invalid setup token" } };
          }
          setupTokenId = tokenData.id;
        }

        const regResult = await processRegistration({
          credential, challenge, challengeValid, userID,
          origin, rpID, currentState, deviceId, deviceName, userAgent, setupTokenId,
        });

        if (!regResult.success) {
          return { result: regResult };
        }

        let updatedState = regResult.data.updatedState;
        if (setupTokenId && regResult.data.credentialId) {
          updatedState = updatedState.updateSetupToken(setupTokenId, {
            credentialId: regResult.data.credentialId,
          });
        }

        return { state: updatedState, result: regResult, setupTokenId };
      });

      if (!result.result.success) {
        return json(res, result.result.statusCode, { error: result.result.message });
      }

      const { session } = result.result.data;
      setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });

      if (result.setupTokenId) {
        bridge.relay({ type: "credential-registered", tokenId: result.setupTokenId });
      }

      json(res, 200, { ok: true });
    }},

    // --- Login ---

    { method: "POST", path: "/auth/login/options", rateLimit: true, handler: async (req, res) => {
      const state = loadState();
      if (!state) {
        return json(res, 400, { error: "Not set up yet" });
      }
      const { rpID } = getOriginAndRpID(req);
      const opts = await generateAuthOpts(state.credentials, rpID);
      storeChallenge(opts.challenge);
      json(res, 200, opts);
    }},

    { method: "POST", path: "/auth/login/verify", rateLimit: true, handler: async (req, res) => {
      const { credential } = await parseJSON(req);
      const { origin, rpID } = getOriginAndRpID(req);

      const lockoutStatus = credentialLockout.isLocked(credential.id);
      if (lockoutStatus.locked) {
        return json(res, 403, {
          error: `Too many failed attempts. Try again in ${lockoutStatus.retryAfter} seconds.`,
          retryAfter: lockoutStatus.retryAfter,
        });
      }

      const challenge = extractChallenge(credential);
      const challengeValid = consumeChallenge(challenge);

      const result = await withStateLock(async (currentState) => {
        const authResult = await processAuthentication({
          credential, challenge, challengeValid, origin, rpID, currentState,
        });

        if (!authResult.success) {
          return { result: authResult };
        }

        return { state: authResult.data.updatedState, result: authResult };
      });

      if (!result.result.success) {
        const lockout = credentialLockout.recordFailure(credential.id);
        if (lockout.locked) {
          return json(res, 403, {
            error: `Too many failed attempts. Account locked for ${lockout.retryAfter} seconds.`,
            retryAfter: lockout.retryAfter,
          });
        }
        return json(res, result.result.statusCode, { error: result.result.message });
      }

      credentialLockout.recordSuccess(credential.id);

      const { session } = result.result.data;
      setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });
      json(res, 200, { ok: true });
    }},

    // --- Logout / Revoke ---

    { method: "POST", path: "/auth/logout", handler: csrf(async (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.get("katulong_session");
      if (token) {
        await withStateLock(async (state) => {
          if (state && state.isValidLoginToken(token)) {
            return { state: state.removeLoginToken(token) };
          }
          return {};
        });
      }
      let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
      if (isHttpsConnection(req)) clearCookie += "; Secure";
      res.setHeader("Set-Cookie", clearCookie);
      json(res, 200, { ok: true });
    })},

    { method: "POST", path: "/auth/revoke-all", handler: auth(csrf(async (req, res) => {
      const state = loadState();
      if (!state) return json(res, 400, { error: "Not set up" });
      await withStateLock((currentState) => {
        if (!currentState) return {};
        return { state: currentState.revokeAllLoginTokens() };
      });
      bridge.relay({ type: "close-all-websockets", code: 1008, reason: "All sessions revoked" });
      let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
      if (isHttpsConnection(req)) clearCookie += "; Secure";
      res.setHeader("Set-Cookie", clearCookie);
      json(res, 200, { ok: true });
    }))},

    // --- Credential API ---

    { method: "GET", path: "/api/credentials", handler: auth((req, res) => {
      const state = loadState();
      if (!state) {
        return json(res, 200, { credentials: [] });
      }
      const credentials = state.credentials.map(c => ({
        id: c.id, name: c.name, createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt, userAgent: c.userAgent,
        setupTokenId: c.setupTokenId || null,
      }));
      json(res, 200, { credentials });
    })},

    { method: "DELETE", prefix: "/api/credentials/", handler: auth(csrf(async (req, res, param) => {
      const credentialId = param;
      if (!credentialId) {
        return json(res, 400, { error: "Credential ID is required" });
      }

      let removedCredentialId = null;
      try {
        const result = await withStateLock((state) => {
          if (!state) return { found: false };
          const credential = state.getCredential(credentialId);
          if (!credential) return { found: false };
          const allowRemoveLast = isLocalRequest(req);
          const updatedState = state.removeCredential(credentialId, { allowRemoveLast });
          return { state: updatedState, found: true, removedCredentialId: credentialId };
        });

        if (!result.found) {
          return json(res, 404, { error: "Credential not found" });
        }
        removedCredentialId = result.removedCredentialId;
      } catch (err) {
        if (err instanceof LastCredentialError) {
          return json(res, 403, { error: "Cannot remove the last credential — would lock you out" });
        }
        throw err;
      }

      if (removedCredentialId) {
        bridge.relay({ type: "close-credential-websockets", credentialId: removedCredentialId });
      }

      log.info("Credential revoked directly", { credentialId });
      json(res, 200, { ok: true });
    }))},

    // --- API Keys ---

    { method: "GET", path: "/api/api-keys", handler: auth((req, res) => {
      const state = loadState();
      if (!state) return json(res, 200, []);
      json(res, 200, state.apiKeys.map(k => ({
        id: k.id, name: k.name, prefix: k.prefix,
        createdAt: k.createdAt, lastUsedAt: k.lastUsedAt,
        scopes: Array.isArray(k.scopes) && k.scopes.length ? [...k.scopes] : [...DEFAULT_API_KEY_SCOPES],
      })));
    })},

    { method: "POST", path: "/api/api-keys", handler: auth(csrf(async (req, res) => {
      const body = await parseJSON(req);
      const { name, scopes } = body || {};
      if (!name || typeof name !== "string") return json(res, 400, { error: "Name required" });
      const scopeResult = validateScopes(scopes);
      if (!scopeResult.valid) {
        return json(res, 400, { error: `Unknown scope(s): ${scopeResult.unknown.join(", ")}` });
      }
      const normalizedScopes = scopeResult.normalized;
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(32).toString("hex");
      const result = await withStateLock((state) => {
        if (!state) return {};
        return {
          state: state.addApiKey({
            id, key, name: name.slice(0, 100),
            createdAt: Date.now(), lastUsedAt: 0,
            scopes: normalizedScopes,
          }),
        };
      });
      if (!result.state) return json(res, 500, { error: "Failed to create API key" });
      json(res, 201, { id, key, name: name.slice(0, 100), prefix: key.slice(0, 8), scopes: normalizedScopes });
    }))},

    { method: "DELETE", prefix: "/api/api-keys/", handler: auth(csrf(async (req, res, id) => {
      if (!id) return json(res, 400, { error: "Key ID required" });
      await withStateLock((state) => {
        if (!state) return {};
        return { state: state.removeApiKey(id) };
      });
      json(res, 200, { ok: true });
    }))},

    // --- Token API ---

    { method: "GET", path: "/api/tokens", handler: auth((req, res) => {
      const state = loadState();
      if (!state) {
        return json(res, 200, { tokens: [] });
      }

      const tokens = state.setupTokens.map(t => {
        const tokenData = {
          id: t.id, name: t.name, createdAt: t.createdAt,
          lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt || null,
          credential: null,
        };
        if (t.credentialId) {
          const credential = state.getCredential(t.credentialId);
          if (credential) {
            tokenData.credential = {
              id: credential.id, name: credential.name,
              createdAt: credential.createdAt, lastUsedAt: credential.lastUsedAt,
              userAgent: credential.userAgent,
            };
          }
        }
        return tokenData;
      });

      json(res, 200, { tokens });
    })},

    { method: "POST", path: "/api/tokens", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return json(res, 400, { error: "Token name is required" });
      }
      if (name.trim().length > 128) {
        return json(res, 400, { error: "Token name too long (max 128 characters)" });
      }

      const { tokenData } = await withStateLock((state) => {
        const now = Date.now();
        const tokenData = {
          id: randomBytes(8).toString("hex"),
          token: randomBytes(16).toString("hex"),
          name: name.trim(),
          createdAt: now,
          lastUsedAt: null,
          expiresAt: now + SETUP_TOKEN_TTL_MS,
        };
        const newState = (state || AuthState.empty()).addSetupToken(tokenData);
        return { state: newState, tokenData };
      });

      log.info("Setup token created", { id: tokenData.id, name: tokenData.name });
      json(res, 200, {
        id: tokenData.id, name: tokenData.name,
        token: tokenData.token, createdAt: tokenData.createdAt,
        expiresAt: tokenData.expiresAt,
      });
    }))},

    { method: "DELETE", prefix: "/api/tokens/", handler: auth(csrf(async (req, res, param) => {
      const id = param;
      if (!id) {
        return json(res, 400, { error: "Token ID is required" });
      }

      let result;
      try {
        result = await withStateLock((state) => {
          if (!state) return { found: false };
          const token = state.setupTokens.find(t => t.id === id);
          if (!token) return { found: false };

          let updatedState = state;
          let removedCredentialId = null;

          if (token.credentialId) {
            const credential = state.getCredential(token.credentialId);
            if (credential) {
              const allowRemoveLast = isLocalRequest(req);
              updatedState = updatedState.removeCredential(token.credentialId, { allowRemoveLast });
              removedCredentialId = token.credentialId;
            }
          }
          updatedState = updatedState.removeSetupToken(id);
          return { state: updatedState, found: true, removedCredentialId };
        });
      } catch (err) {
        if (err instanceof LastCredentialError) {
          return json(res, 403, { error: "Cannot revoke the last credential — would lock you out" });
        }
        throw err;
      }

      if (!result.found) {
        return json(res, 404, { error: "Token not found" });
      }

      if (result.removedCredentialId) {
        bridge.relay({ type: "close-credential-websockets", credentialId: result.removedCredentialId });
      }

      log.info("Setup token revoked", { id, credentialRevoked: !!result.removedCredentialId });
      json(res, 200, { ok: true });
    }))},

    { method: "PATCH", prefix: "/api/tokens/", handler: auth(csrf(async (req, res, param) => {
      const id = param;
      if (!id) {
        return json(res, 400, { error: "Token ID is required" });
      }

      const { name } = await parseJSON(req);
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return json(res, 400, { error: "Token name is required" });
      }

      const result = await withStateLock((state) => {
        if (!state) return { found: false };
        const tokenExists = state.setupTokens.some(t => t.id === id);
        if (!tokenExists) return { found: false };
        return { state: state.updateSetupToken(id, { name: name.trim() }), found: true };
      });

      if (!result.found) {
        return json(res, 404, { error: "Token not found" });
      }

      log.info("Setup token updated", { id, name: name.trim() });
      json(res, 200, { ok: true });
    }))},

    // --- Session minting (fleet federation) ---
    //
    // POST /api/sessions/mint — Bearer + "mint-session" scope. Returns a
    // single-use consume URL. The hub server calls this, then the browser
    // GETs the consume URL to land a first-party cookie on the instance.

    { method: "POST", path: "/api/sessions/mint", rateLimit: true, handler: auth(requireBearerAuth(requireScope(SCOPE_MINT_SESSION)(async (req, res) => {
      const state = loadState();
      if (!state || !state.hasCredentials()) {
        return json(res, 409, { error: "Instance has no registered credentials" });
      }

      // Body is optional — a minimal mint request may carry no parameters.
      // An invalid-JSON body is treated as empty, but an oversized body
      // (1MB cap in readBody) is surfaced as 413 rather than silently
      // absorbed. readBody rejects with Error("Request body too large").
      let body;
      try {
        body = await parseJSON(req);
      } catch (err) {
        if (err && /too large/i.test(err.message)) {
          return json(res, 413, { error: "Request body too large" });
        }
        body = {};
      }
      const returnTo = typeof body?.returnTo === "string" ? body.returnTo : null;
      const ttlSecondsRaw = Number(body?.ttlSeconds);
      const ttlMs = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0
        ? Math.min(ttlSecondsRaw * 1000, MINT_MAX_TTL_MS)
        : MINT_DEFAULT_TTL_MS;

      // Validate returnTo is same-origin before minting so a bad hub can't
      // mint a token that silently redirects off-instance on consume.
      const { origin: serverOrigin } = getOriginAndRpID(req);
      if (returnTo) {
        try {
          const parsed = new URL(returnTo, serverOrigin);
          if (parsed.origin !== serverOrigin) {
            return json(res, 400, { error: "returnTo must be same-origin" });
          }
        } catch {
          return json(res, 400, { error: "Invalid returnTo URL" });
        }
      }

      // Bind minted session to the first registered credential — the one
      // `isValidLoginToken` will cross-check. If that credential is later
      // revoked, removeCredential() cascades and invalidates the session.
      const credentialId = state.credentials[0].id;

      const consumeToken = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + ttlMs;
      pendingMints.set(consumeToken, {
        credentialId,
        returnTo,
        expiresAt,
        apiKeyId: req._apiKeyId || null,
      });

      const consumeUrl = new URL("/auth/consume", serverOrigin);
      consumeUrl.searchParams.set("token", consumeToken);
      if (returnTo) consumeUrl.searchParams.set("return", returnTo);

      log.info("Session mint created", {
        apiKeyId: req._apiKeyId || null,
        credentialId,
        ttlMs,
        hasReturnTo: !!returnTo,
      });

      json(res, 201, {
        consumeUrl: consumeUrl.toString(),
        expiresAt,
        credentialId,
      });
    })))},

    { method: "GET", path: "/auth/consume", handler: async (req, res) => {
      // Public route — the consume token IS the auth. Single-use via
      // atomic Map.delete(); return validated same-origin before redirect.
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const returnParam = url.searchParams.get("return");

      if (!token || typeof token !== "string") {
        return json(res, 400, { error: "Missing consume token" });
      }
      if (token.length > MAX_CONSUME_TOKEN_LEN) {
        return json(res, 400, { error: "Consume token too long" });
      }
      // Consume tokens are `randomBytes(32).toString("hex")` — 64 lowercase
      // hex chars. Reject any other shape before the Map lookup both as
      // defense-in-depth and as a self-documenting contract.
      if (!/^[0-9a-f]+$/.test(token)) {
        return json(res, 400, { error: "Invalid consume token format" });
      }

      const entry = pendingMints.get(token);
      // Claim atomically: if delete returns true we own it. JS is
      // single-threaded per event loop turn and there's no await between
      // get and delete, so no coroutine can interleave here.
      const claimed = pendingMints.delete(token);
      if (!entry || !claimed) {
        return json(res, 404, { error: "Consume token not found or already used" });
      }
      if (Date.now() >= entry.expiresAt) {
        return json(res, 410, { error: "Consume token expired" });
      }

      // Re-validate return URL against the current request origin (not the
      // origin at mint time) so the browser's actual hostname governs.
      const { origin: serverOrigin } = getOriginAndRpID(req);
      let redirectTo = "/";
      const candidate = returnParam || entry.returnTo;
      if (candidate) {
        try {
          const parsed = new URL(candidate, serverOrigin);
          if (parsed.origin !== serverOrigin) {
            return json(res, 400, { error: "return must be same-origin" });
          }
          redirectTo = parsed.pathname + parsed.search + parsed.hash;
        } catch {
          return json(res, 400, { error: "Invalid return URL" });
        }
      }

      // Confirm the bound credential still exists on the instance. If it
      // was revoked between mint and consume, fail closed rather than
      // creating a session tied to a missing credential.
      const currentState = loadState();
      if (!currentState || !currentState.getCredential(entry.credentialId)) {
        return json(res, 409, { error: "Bound credential no longer exists" });
      }

      const session = createLoginToken();
      const result = await withStateLock((state) => {
        if (!state) return {};
        const updated = state
          .pruneExpired()
          .addLoginToken(
            session.token,
            session.expiry,
            entry.credentialId,
            session.csrfToken,
            session.lastActivityAt,
          );
        return { state: updated };
      });

      if (!result.state) {
        return json(res, 500, { error: "Failed to create session" });
      }

      setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });

      log.info("Session mint consumed", {
        credentialId: entry.credentialId,
        apiKeyId: entry.apiKeyId,
        hasReturn: !!candidate,
      });

      res.writeHead(302, { Location: redirectTo });
      res.end();
    }},

    // --- Device-to-device auth ---

    { method: "POST", path: "/auth/device-auth/request", rateLimit: true, handler: async (req, res) => {
      const requestId = randomUUID();
      const code = Math.floor(Math.random() * 90) + 10; // 10-99
      const userAgent = req.headers["user-agent"] || "Unknown";

      deviceAuthRequests.set(requestId, {
        code,
        userAgent,
        createdAt: Date.now(),
        approved: false,
        sessionToken: null,
        credentialId: null,
      });

      bridge.relay({ type: "device-auth-request", requestId, code, userAgent });
      log.info("Device auth request created", { requestId, code });
      json(res, 200, { requestId, code });
    }},

    { method: "GET", path: "/auth/device-auth/status", rateLimit: true, handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const requestId = url.searchParams.get("id");
      if (!requestId) {
        return json(res, 400, { error: "Missing request ID" });
      }

      const request = deviceAuthRequests.get(requestId);
      if (!request || isDeviceAuthExpired(request)) {
        deviceAuthRequests.delete(requestId);
        return json(res, 200, { status: "expired" });
      }

      if (!request.approved) {
        return json(res, 200, { status: "pending" });
      }

      // Approved — create session and set cookie
      const session = createLoginToken();
      const result = await withStateLock((currentState) => {
        if (!currentState) return {};
        const updatedState = currentState
          .pruneExpired()
          .addLoginToken(session.token, session.expiry, request.credentialId, session.csrfToken, session.lastActivityAt);
        return { state: updatedState };
      });

      if (result.state) {
        setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });
      }

      // Clean up the request
      deviceAuthRequests.delete(requestId);
      json(res, 200, { status: "approved" });
    }},

    { method: "POST", path: "/auth/device-auth/approve", handler: auth(csrf(async (req, res) => {
      const { requestId } = await parseJSON(req);
      if (!requestId || typeof requestId !== "string") {
        return json(res, 400, { error: "requestId required" });
      }

      const request = deviceAuthRequests.get(requestId);
      if (!request || isDeviceAuthExpired(request)) {
        deviceAuthRequests.delete(requestId);
        return json(res, 404, { error: "Request expired or not found" });
      }

      // Get the approving user's credential ID from their session
      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies.get("katulong_session");
      const state = loadState();
      const loginToken = state?.loginTokens?.[sessionToken];
      const credentialId = loginToken?.credentialId || null;

      request.approved = true;
      request.credentialId = credentialId;

      log.info("Device auth request approved", { requestId, credentialId });
      json(res, 200, { ok: true });
    }))},

    { method: "POST", path: "/auth/device-auth/deny", handler: auth(csrf(async (req, res) => {
      const { requestId } = await parseJSON(req);
      if (!requestId || typeof requestId !== "string") {
        return json(res, 400, { error: "requestId required" });
      }

      deviceAuthRequests.delete(requestId);
      log.info("Device auth request denied", { requestId });
      json(res, 200, { ok: true });
    }))},
  ];
}
