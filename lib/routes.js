/**
 * HTTP Routes
 *
 * All route definitions: middleware, auth, and app routes in a single module.
 * Consolidated from lib/routes/middleware.js, lib/routes/auth.js, and lib/routes/app.js.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  loadState, isSetup, withStateLock,
  generateRegistrationOpts,
  generateAuthOpts,
  createLoginToken,
} from "./auth.js";
import {
  parseCookies, setSessionCookie, getOriginAndRpID,
  isAllowedCorsOrigin, isHttpsConnection,
  getCsrfToken, escapeAttr, getCspHeaders,
  validateCsrfToken,
} from "./http-util.js";
import { isLocalRequest, getAccessMethod } from "./access-method.js";
import { processRegistration, processAuthentication, extractChallenge } from "./auth-handlers.js";
import { AuthState, LastCredentialError } from "./auth-state.js";
import { SETUP_TOKEN_TTL_MS } from "./env-config.js";
import { SessionName } from "./session-name.js";
import { loadShortcuts, saveShortcuts } from "./shortcuts.js";
import { log } from "./log.js";
import { rewriteVendorUrls } from "./static-files.js";
import { captureVisiblePane } from "./tmux.js";
import { bridgeClipboardToContainers, bridgePaneContainer } from "./container-detect.js";

// --- Image upload helpers (inlined from lib/upload.js) ---

const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ext: "png" },
  { magic: Buffer.from([0xff, 0xd8, 0xff]),        ext: "jpg" },
  { magic: Buffer.from("GIF8"),                     ext: "gif" },
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function detectImage(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length >= sig.magic.length && buf.subarray(0, sig.magic.length).equals(sig.magic)) {
      return sig.ext;
    }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "webp";
  }
  return null;
}

import { readRawBody } from "./request-util.js";

function imageMimeType(ext) {
  return ext === "png" ? "image/png" : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp" : "image/jpeg";
}


/**
 * Set the host clipboard to an image file.
 * Returns true if clipboard was set successfully.
 */
async function setClipboard(filePath, ext, log) {
  if (process.platform === "darwin") {
    const applescriptType = ext === "png" ? "«class PNGf»" : ext === "gif" ? "«class GIFf»" : "«class JPEG»";
    try {
      await new Promise((resolve, reject) => {
        execFile("osascript", ["-e", `set the clipboard to (read (POSIX file "${filePath}") as ${applescriptType})`],
          { timeout: 5000 }, (err) => err ? reject(err) : resolve());
      });
      return true;
    } catch (err) {
      log.warn("Failed to copy image to clipboard", { error: err.message });
    }
  } else if (process.platform === "linux") {
    if (!process.env.DISPLAY) {
      try {
        const xvfbDisplay = await new Promise((resolve, reject) => {
          execFile("pgrep", ["-a", "Xvfb"], { timeout: 2000 }, (err, stdout) => {
            if (err) return reject(err);
            const match = stdout.match(/:(\d+)/);
            resolve(match ? `:${match[1]}` : null);
          });
        });
        if (xvfbDisplay) {
          process.env.DISPLAY = xvfbDisplay;
          log.info("Auto-detected Xvfb display", { display: xvfbDisplay });
          execFile("tmux", ["setenv", "-g", "DISPLAY", xvfbDisplay], { timeout: 2000 }, () => {});
        }
      } catch { /* Xvfb not running */ }
    }
    const mimeType = imageMimeType(ext);
    try {
      await new Promise((resolve, reject) => {
        execFile("xclip", ["-selection", "clipboard", "-t", mimeType, "-i", filePath],
          { timeout: 5000 }, (err) => err ? reject(err) : resolve());
      });
      return true;
    } catch (err) {
      const msg = err.code === "ENOENT"
        ? "xclip not installed — image clipboard paste disabled (apt-get install xclip)"
        : `xclip failed — image clipboard paste disabled (is DISPLAY set?)`;
      log.warn(msg, { error: err.message });
    }
  }
  return false;
}

// --- Middleware ---

export function createMiddleware(ctx) {
  const { isAuthenticated, json } = ctx;

  function auth(handler) {
    return async (req, res, param) => {
      if (!isAuthenticated(req)) {
        return json(res, 401, { error: "Authentication required" });
      }
      return handler(req, res, param);
    };
  }

  function csrf(handler) {
    return async (req, res, param) => {
      // Skip CSRF for API key auth (Bearer token) and localhost
      if (!isLocalRequest(req) && !req._apiKeyAuth) {
        const state = loadState();
        if (!validateCsrfToken(req, state)) {
          return json(res, 403, { error: "Invalid or missing CSRF token" });
        }
      }
      return handler(req, res, param);
    };
  }

  return { auth, csrf };
}

// --- Device-to-device auth (ephemeral, in-memory only) ---

const deviceAuthRequests = new Map(); // requestId -> { code, userAgent, createdAt, approved, sessionToken, credentialId }
const DEVICE_AUTH_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isDeviceAuthExpired(request) {
  return Date.now() - request.createdAt > DEVICE_AUTH_TTL_MS;
}

// --- Auth routes ---

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

// --- App routes ---

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated, sessionManager,
    helmSessionManager, bridge,
    configManager, __dirname, DATA_DIR, APP_VERSION,
    getDraining, shortcutsPath,
    auth, csrf, topicBroker, getExternalUrl,
  } = ctx;

  // Publish session output and exit events to topic broker for SSE subscribers
  // (used by `crew output --follow` to replace polling with push).
  if (topicBroker && bridge) {
    bridge.register((msg) => {
      if (msg.type === "output" && msg.session && msg.data) {
        topicBroker.publish(`sessions/${msg.session}/output`, msg.data);
      } else if (msg.type === "exit" && msg.session) {
        topicBroker.publish(`sessions/${msg.session}/output`, "", { event: "exit", code: msg.code });
      }
    });
  }

  function configPutRoute(path, fieldName, setter, getter) {
    return { method: "PUT", path, handler: auth(csrf(async (req, res) => {
      const body = await parseJSON(req);
      const value = body[fieldName];
      try {
        await setter(value);
        log.info(`${fieldName} updated`, { [fieldName]: value });
        json(res, 200, { success: true, [fieldName]: getter() });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    }))};
  }

  return [
    // --- Health ---

    { method: "GET", path: "/health", handler: (req, res) => {
      if (getDraining()) {
        return json(res, 503, { status: "draining" });
      }
      const response = { status: "ok", version: APP_VERSION };
      // Only include diagnostic details for authenticated requests
      if (isAuthenticated(req)) {
        response.pid = process.pid;
        response.uptime = process.uptime();
      }
      json(res, 200, response);
    }},

    // --- Pages ---

    { method: "GET", path: "/", handler: (req, res) => {
      let html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");

      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies.get("katulong_session");
      if (sessionToken) {
        const state = loadState();
        const csrfToken = getCsrfToken(state, sessionToken);
        if (csrfToken) {
          html = html.replace("<head>", `<head>\n    <meta name="csrf-token" content="${escapeAttr(csrfToken)}">`);
        }
      }

      html = html.replace("<body>", `<body data-version="${escapeAttr(APP_VERSION)}">`);

      // Rewrite vendor URLs with content hashes for CDN cache busting
      html = rewriteVendorUrls(html);

      res.writeHead(200, {
        "Content-Type": "text/html",
        ...getCspHeaders()
      });
      res.end(html);
    }},

    { method: "GET", path: "/manifest.json", handler: (req, res) => {
      const manifest = readFileSync(join(__dirname, "public", "manifest.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(manifest);
    }},

    // Service worker — inject version so PWA cache updates on each release
    { method: "GET", path: "/sw.js", handler: (req, res) => {
      try {
        const swContent = readFileSync(join(__dirname, "public", "sw.js"), "utf-8")
          .replace(/__APP_VERSION__/g, APP_VERSION);
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(swContent);
      } catch (err) {
        log.error("Failed to serve sw.js", { error: err.message });
        res.writeHead(500);
        res.end();
      }
    }},

    { method: "GET", path: "/login", handler: (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        ...getCspHeaders()
      });
      let loginHtml = readFileSync(join(__dirname, "public", "login.html"), "utf-8");
      loginHtml = rewriteVendorUrls(loginHtml);
      res.end(loginHtml);
    }},

    // --- Upload ---

    { method: "POST", path: "/upload", handler: auth(csrf(async (req, res) => {
      let buf;
      try {
        buf = await readRawBody(req, MAX_UPLOAD_BYTES);
      } catch {
        return json(res, 413, { error: "File too large (max 10 MB)" });
      }
      const ext = detectImage(buf);
      if (!ext) {
        return json(res, 400, { error: "Not a supported image type" });
      }
      const uploadsDir = join(DATA_DIR, "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      const filePath = join(uploadsDir, filename);
      writeFileSync(filePath, buf);

      // Set clipboard during upload. For multi-file drops, the client
      // queues the Ctrl+V sends sequentially — each upload's /paste call
      // re-sets the clipboard before sending Ctrl+V.
      let clipboard = await setClipboard(filePath, ext, log);
      const mimeType = imageMimeType(ext);
      const containerBridged = await bridgeClipboardToContainers(filename, mimeType, log);
      if (containerBridged) clipboard = true;

      // Bridge to the container the user has docker-exec'd into (if any)
      if (!containerBridged) {
        const sessionHeader = req.headers["x-session"];
        const sessionName = sessionHeader ? SessionName.tryCreate(sessionHeader) : null;
        if (sessionName) {
          const paneBridged = await bridgePaneContainer(sessionName.toString(), sessionManager, filePath, mimeType, log);
          if (paneBridged) clipboard = true;
        }
      }

      json(res, 200, { path: `/uploads/${filename}`, fsPath: filePath, clipboard });
    }))},

    // --- Paste (set clipboard + write Ctrl+V to PTY for each image) ---
    //
    // Accepts an array of uploaded paths and a session name. For each path,
    // sets the clipboard, bridges to containers, and writes Ctrl+V directly
    // to the tmux session. All done server-side in a single HTTP request to
    // avoid per-file tunnel round-trips.

    { method: "POST", path: "/paste", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const paths = Array.isArray(data.paths) ? data.paths : data.path ? [data.path] : [];
      if (paths.length === 0) return json(res, 400, { error: "Missing paths" });

      const pasteSession = data.session ? SessionName.tryCreate(data.session)?.toString() : null;
      const uploadsDir = join(DATA_DIR, "uploads");
      const PASTE_DELAY_MS = 50;

      // Respond immediately — pastes happen async with WS progress updates
      json(res, 200, { queued: paths.length });

      // Process pastes sequentially in the background
      (async () => {
        for (const p of paths) {
          if (typeof p !== "string") continue;
          const filePath = join(uploadsDir, p.replace(/^\/uploads\//, ""));
          if (!filePath.startsWith(uploadsDir) || !existsSync(filePath)) continue;

          const ext = filePath.split(".").pop();
          const filename = filePath.split("/").pop();
          const mimeType = imageMimeType(ext);

          let clipboard = await setClipboard(filePath, ext, log);
          const bridged = await bridgeClipboardToContainers(filename, mimeType, log);
          if (bridged) clipboard = true;

          // Bridge to docker-exec'd container in this session's pane
          if (!bridged && pasteSession) {
            const paneBridged = await bridgePaneContainer(pasteSession, sessionManager, filePath, mimeType, log);
            if (paneBridged) clipboard = true;
          }

          if (clipboard && pasteSession) {
            const session = sessionManager.getSession(pasteSession);
            if (session?.alive) session.write("\x16");
          }

          // Notify client via WebSocket that this file was pasted
          bridge.relay({ type: "paste-complete", session: data.session, path: p });

          await new Promise(r => setTimeout(r, PASTE_DELAY_MS));
        }
      })();
    }))},

    // --- Shortcuts ---

    { method: "GET", path: "/shortcuts", handler: auth((req, res) => {
      const result = loadShortcuts(shortcutsPath);
      json(res, 200, result.success ? result.data : []);
    })},

    { method: "PUT", path: "/shortcuts", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const result = saveShortcuts(shortcutsPath, data);
      json(res, result.success ? 200 : 400, result.success ? { ok: true } : { error: result.message });
    }))},

    // --- Attach (open tab in browser, create session if needed) ---

    { method: "POST", path: "/attach", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const sessionName = data.name ? SessionName.tryCreate(data.name) : null;
      if (!sessionName) return json(res, 400, { error: "Invalid session name" });
      const session = sessionManager.getSession(sessionName.toString());
      if (!session) return json(res, 404, { error: "Session not found" });
      bridge.relay({ type: "open-tab", session: sessionName.toString() });
      json(res, 200, { name: sessionName.toString() });
    }))},

    // --- Notify (send native notification to connected browsers) ---

    { method: "POST", path: "/notify", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const message = typeof data.message === "string" ? data.message.slice(0, 1000) : "";
      if (!message) return json(res, 400, { error: "Missing message" });
      const title = typeof data.title === "string" ? data.title.slice(0, 200) : "Katulong";
      bridge.relay({ type: "notification", title, message });
      if (topicBroker) topicBroker.publish("_notify", message, { title });
      json(res, 200, { ok: true });
    }))},

    // --- Pub/Sub ---

    { method: "POST", path: "/pub", handler: auth(csrf(async (req, res) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      const data = await parseJSON(req);
      const topic = typeof data.topic === "string" ? data.topic.slice(0, 128) : "";
      const message = typeof data.message === "string" ? data.message.slice(0, 65536) : "";
      if (!topic) return json(res, 400, { error: "Missing topic" });
      if (!message) return json(res, 400, { error: "Missing message" });
      if (!/^[a-zA-Z0-9._\-/]+$/.test(topic)) return json(res, 400, { error: "Invalid topic (alphanumeric, dots, dashes, slashes)" });
      const delivered = topicBroker.publish(topic, message);
      json(res, 200, { ok: true, delivered });
    }))},

    { method: "GET", prefix: "/sub/", handler: auth((req, res, topic) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic)) return json(res, 400, { error: "Invalid topic" });

      // Parse optional fromSeq query param for replay
      const url = new URL(req.url, "http://localhost");
      const fromSeqParam = url.searchParams.get("fromSeq");
      const fromSeq = fromSeqParam !== null ? parseInt(fromSeqParam, 10) : undefined;

      // SSE stream
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":ok\n\n");

      const unsubscribe = topicBroker.subscribe(topic, (envelope) => {
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
      }, { fromSeq });

      req.on("close", unsubscribe);
    })},

    { method: "GET", path: "/api/topics", handler: auth((req, res) => {
      if (!topicBroker) return json(res, 200, []);
      json(res, 200, topicBroker.listTopics());
    })},

    // --- Sessions ---

    { method: "GET", path: "/sessions", handler: auth((req, res) => {
      const result = sessionManager.listSessions();
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/sessions", handler: auth(csrf(async (req, res) => {
      const { name, copyFrom } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(name);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const copyFromName = copyFrom ? SessionName.tryCreate(copyFrom)?.toString() : null;
      const result = await sessionManager.createSession(sessionName.toString(), 120, 40, copyFromName);
      if (!result.error && req._apiKeyAuth) {
        const session = sessionManager.getSession(result.name);
        if (session) session.setIcon("robot");
      }
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
    }))},

    { method: "GET", prefix: "/sessions/cwd/", handler: auth(async (req, res, name) => {
      const cwd = await sessionManager.getSessionCwd(name);
      json(res, cwd ? 200 : 404, cwd ? { cwd } : { error: "Session not found" });
    })},

    // --- Session I/O (exec + output) ---

    { method: "POST", prefix: "/sessions/", handler: auth(csrf(async (req, res, param) => {
      if (!param.endsWith("/exec")) return json(res, 404, { error: "Not found" });
      const rawName = decodeURIComponent(param.slice(0, param.length - "/exec".length));
      const sessionName = SessionName.tryCreate(rawName);
      if (!sessionName) return json(res, 400, { error: "Invalid session name" });
      const session = sessionManager.getSession(sessionName.toString());
      if (!session || !session.alive) return json(res, 404, { error: "Session not found or not alive" });
      const { input } = await parseJSON(req);
      if (typeof input !== "string") return json(res, 400, { error: "Missing input string" });
      if (input.length > 65536) return json(res, 400, { error: "Input too large (max 64KB)" });
      session.write(input + "\r");
      json(res, 200, { ok: true });
    }))},

    { method: "GET", prefix: "/sessions/", handler: auth(async (req, res, param) => {
      // --- Session status (for orchestrator polling) ---
      if (param.endsWith("/status")) {
        const rawName = decodeURIComponent(param.slice(0, param.length - "/status".length));
        const sessionName = SessionName.tryCreate(rawName);
        if (!sessionName) return json(res, 400, { error: "Invalid session name" });
        const session = sessionManager.getSession(sessionName.toString());
        if (!session) return json(res, 404, { error: "Session not found" });
        return json(res, 200, {
          name: session.name,
          alive: session.alive,
          hasChildProcesses: session.hasChildProcesses(),
          childCount: session._childCount,
        });
      }

      if (!param.endsWith("/output")) return json(res, 404, { error: "Not found" });
      const rawName = decodeURIComponent(param.slice(0, param.length - "/output".length));
      const sessionName = SessionName.tryCreate(rawName);
      if (!sessionName) return json(res, 400, { error: "Invalid session name" });
      const session = sessionManager.getSession(sessionName.toString());
      if (!session) return json(res, 404, { error: "Session not found" });

      const url = new URL(req.url, "http://localhost");
      const fromSeq = url.searchParams.get("fromSeq");
      const lines = url.searchParams.get("lines");
      const screen = url.searchParams.get("screen");

      if (screen === "true") {
        const snapshot = session.serializeScreen();
        return json(res, 200, { screen: snapshot, seq: session.outputBuffer.totalBytes });
      }
      if (fromSeq !== null) {
        const seq = parseInt(fromSeq, 10);
        if (isNaN(seq) || seq < 0) return json(res, 400, { error: "Invalid fromSeq" });
        const data = session.outputBuffer.sliceFrom(seq);
        if (data === null) {
          const snapshot = session.serializeScreen();
          return json(res, 200, { screen: snapshot, seq: session.outputBuffer.totalBytes, evicted: true });
        }
        return json(res, 200, { data, seq: session.outputBuffer.totalBytes });
      }
      if (lines !== null) {
        const n = parseInt(lines, 10);
        if (isNaN(n) || n < 1 || n > 1000) return json(res, 400, { error: "Invalid lines (1-1000)" });
        const visible = await captureVisiblePane(session.tmuxName);
        const allLines = (visible || "").split("\n");
        const lastN = allLines.slice(-n).join("\n");
        return json(res, 200, { data: lastN, seq: session.outputBuffer.totalBytes });
      }

      // Default: last 4KB of raw buffer
      const total = session.outputBuffer.totalBytes;
      const startOffset = Math.max(total - 4096, session.outputBuffer.getStartOffset());
      const data = session.outputBuffer.sliceFrom(startOffset);
      json(res, 200, { data: data || "", seq: total });
    })},

    { method: "DELETE", prefix: "/sessions/", handler: auth(csrf((req, res, name) => {
      const url = new URL(req.url, "http://localhost");
      const detachOnly = url.searchParams.get("action") === "detach";
      const result = sessionManager.deleteSession(name, { detachOnly });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true, action: result.action });
    }))},

    { method: "PUT", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const { name: newName } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(newName);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await sessionManager.renameSession(name, sessionName.toString());
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
    }))},

    // --- tmux session browser ---

    { method: "GET", path: "/tmux-sessions", handler: auth(async (req, res) => {
      const result = await sessionManager.listTmuxSessions();
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/tmux-sessions/adopt", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      if (!name || typeof name !== "string") return json(res, 400, { error: "Invalid name" });
      const result = await sessionManager.adoptTmuxSession(name);
      json(res, result.error ? 409 : 201, result);
    }))},

    { method: "DELETE", prefix: "/tmux-sessions/", handler: auth(csrf(async (req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const result = await sessionManager.killTmuxSession(name);
      json(res, result.error ? 400 : 200, result);
    }))},

    // --- Claude sessions ---

    { method: "GET", path: "/api/helm-sessions", handler: auth((req, res) => {
      json(res, 200, { sessions: helmSessionManager.listSessions() });
    })},

    // --- Config ---

    { method: "GET", path: "/api/config", handler: auth(async (req, res) => {
      const config = configManager.getConfig();
      json(res, 200, { config });
    })},

    { method: "GET", path: "/api/external-url", handler: auth((req, res) => {
      json(res, 200, { url: getExternalUrl ? getExternalUrl() : null });
    })},

    configPutRoute("/api/config/instance-name", "instanceName", (v) => configManager.setInstanceName(v), () => configManager.getInstanceName()),
    configPutRoute("/api/config/instance-icon", "instanceIcon", (v) => configManager.setInstanceIcon(v), () => configManager.getInstanceIcon()),
    configPutRoute("/api/config/toolbar-color", "toolbarColor", (v) => configManager.setToolbarColor(v), () => configManager.getToolbarColor()),
    configPutRoute("/api/config/port-proxy-enabled", "portProxyEnabled", (v) => configManager.setPortProxyEnabled(v), () => configManager.getPortProxyEnabled()),

    // --- Notes (per-session markdown) ---

    { method: "GET", prefix: "/api/notes/", handler: auth((req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          json(res, 200, { content });
        } else {
          json(res, 200, { content: "" });
        }
      } catch (err) {
        log.error("Failed to read note", { name, error: err.message });
        json(res, 500, { error: "Failed to read note" });
      }
    })},

    { method: "PUT", prefix: "/api/notes/", handler: auth(csrf(async (req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      const { content } = await parseJSON(req);
      if (typeof content !== "string") return json(res, 400, { error: "Invalid content" });
      try {
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        log.error("Failed to save note", { name, error: err.message });
        json(res, 500, { error: "Failed to save note" });
      }
    }))},

    { method: "DELETE", prefix: "/api/notes/", handler: auth(csrf((req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        json(res, 200, { ok: true });
      } catch (err) {
        log.error("Failed to delete note", { name, error: err.message });
        json(res, 500, { error: "Failed to delete note" });
      }
    }))},
  ];
}
