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

import { randomBytes, randomInt, randomUUID } from "node:crypto";
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

export function createAuthRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated,
    storeChallenge, consumeChallenge, challengeStore,
    credentialLockout, bridge,
    RP_NAME, PORT,
    auth, csrf,
  } = ctx;

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
      })));
    })},

    { method: "POST", path: "/api/api-keys", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      if (!name || typeof name !== "string") return json(res, 400, { error: "Name required" });
      const id = randomBytes(8).toString("hex");
      const key = randomBytes(32).toString("hex");
      const result = await withStateLock((state) => {
        if (!state) return {};
        return { state: state.addApiKey({ id, key, name: name.slice(0, 100), createdAt: Date.now(), lastUsedAt: 0 }) };
      });
      if (!result.state) return json(res, 500, { error: "Failed to create API key" });
      json(res, 201, { id, key, name: name.slice(0, 100), prefix: key.slice(0, 8) });
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

    // --- Device-to-device auth ---

    { method: "POST", path: "/auth/device-auth/request", rateLimit: true, handler: async (req, res) => {
      const requestId = randomUUID();
      // 6-digit cryptographically random code (000000–999999, ~20 bits of
      // entropy). The previous 2-digit Math.random() code had only 90
      // possible values — even with rate limiting, an attacker probing
      // /auth/device-auth/status could enumerate all values within the
      // 5-minute approval window. randomInt is rejection-sampled so each
      // value is uniform.
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
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
      // Don't log the code value — it's the approval secret. requestId
      // is enough for correlation, and DATA_DIR/launchd-stdout.log may
      // be readable to anyone with a shell on the host.
      log.info("Device auth request created", { requestId });
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
