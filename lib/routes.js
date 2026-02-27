/**
 * HTTP Routes
 *
 * All route definitions: middleware, auth, and app routes in a single module.
 * Consolidated from lib/routes/middleware.js, lib/routes/auth.js, and lib/routes/app.js.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  loadState, isSetup, withStateLock,
  generateRegistrationOpts, generateRegistrationOptsForUser,
  generateAuthOpts,
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
import { SessionName } from "./session-name.js";
import { log } from "./log.js";

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

export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
      if (!isLocalRequest(req)) {
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

// --- Auth routes ---

export function createAuthRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated,
    storeChallenge, consumeChallenge, challengeStore,
    credentialLockout, broadcastToAll, closeWebSocketsForCredential, closeAllWebSockets,
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
      const { origin, rpID } = getOriginAndRpID(req);
      log.info("POST /auth/register/options: request received", {
        ip: req.socket.remoteAddress,
        origin, rpID,
        isLocal: isLocalRequest(req),
      });

      const { setupToken } = await parseJSON(req);
      log.debug("POST /auth/register/options: parsed body", { hasSetupToken: !!setupToken });

      let state = loadState();
      if (!state) {
        log.debug("POST /auth/register/options: no existing state, creating empty state");
        const firstTimeResult = await withStateLock((currentState) => {
          if (currentState) return { state: currentState };
          const newState = AuthState.empty();
          return { state: newState };
        });
        state = firstTimeResult.state;
      }

      const isFirstRegistration = !isSetup();
      const isLocal = isLocalRequest(req);
      log.debug("POST /auth/register/options: registration context", {
        isFirstRegistration, isLocal,
        existingCredentials: state?.credentials?.length ?? 0,
      });

      if (isFirstRegistration && isLocal) {
        log.info("First passkey registration from localhost - no token required");
      } else {
        const tokenData = state.findSetupToken(setupToken);
        if (!tokenData) {
          log.warn("POST /auth/register/options: invalid setup token", {
            isLocal, isFirstRegistration,
          });
          return json(res, 403, { error: "Invalid setup token" });
        }
        log.debug("POST /auth/register/options: setup token validated", { tokenId: tokenData.id });
        await withStateLock((currentState) => {
          return { state: currentState.updateSetupToken(tokenData.id, { lastUsedAt: Date.now() }) };
        });
      }

      let opts, userID;
      if (isSetup()) {
        if (state.user && state.user.id) {
          log.debug("POST /auth/register/options: generating opts for existing user");
          ({ opts, userID } = await generateRegistrationOptsForUser(state.user.id, RP_NAME, rpID, origin));
        } else {
          log.debug("POST /auth/register/options: generating opts (no existing user ID)");
          ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, origin));
        }
      } else {
        log.debug("POST /auth/register/options: generating opts for first-time setup");
        ({ opts, userID } = await generateRegistrationOpts(RP_NAME, rpID, origin));
      }
      storeChallenge(opts.challenge);
      challengeStore.setMeta(opts.challenge, "userID", userID);
      json(res, 200, opts);
    }},

    { method: "POST", path: "/auth/register/verify", rateLimit: true, handler: async (req, res) => {
      const { origin, rpID } = getOriginAndRpID(req);
      log.info("POST /auth/register/verify: request received", {
        ip: req.socket.remoteAddress,
        origin, rpID,
        isLocal: isLocalRequest(req),
        isHttps: isHttpsConnection(req),
      });

      const { credential, setupToken, deviceId, deviceName, userAgent: clientUserAgent } = await parseJSON(req);
      log.debug("POST /auth/register/verify: parsed body", {
        credentialId: credential?.id,
        hasSetupToken: !!setupToken,
        deviceName: deviceName || null,
      });

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
            log.warn("POST /auth/register/verify: setup token invalid inside lock");
            return { result: { success: false, statusCode: 403, message: "Invalid setup token" } };
          }
          setupTokenId = tokenData.id;
        }

        const regResult = await processRegistration({
          credential, challenge, challengeValid, userID,
          origin, rpID, currentState, deviceId, deviceName, userAgent, setupTokenId,
        });

        if (!regResult.success) {
          log.warn("POST /auth/register/verify: processRegistration failed", {
            code: regResult.code,
            message: regResult.message,
          });
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
        log.warn("POST /auth/register/verify: registration failed", {
          statusCode: result.result.statusCode,
          message: result.result.message,
        });
        return json(res, result.result.statusCode, { error: result.result.message });
      }

      const { session } = result.result.data;
      setSessionCookie(res, session.token, session.expiry, { secure: isHttpsConnection(req) });

      if (result.setupTokenId) {
        broadcastToAll({ type: "credential-registered", tokenId: result.setupTokenId });
      }

      log.info("POST /auth/register/verify: registration complete");
      json(res, 200, { ok: true });
    }},

    // --- Login ---

    { method: "POST", path: "/auth/login/options", rateLimit: true, handler: async (req, res) => {
      const { rpID } = getOriginAndRpID(req);
      log.info("POST /auth/login/options: request received", {
        rpID, isLocal: isLocalRequest(req),
      });

      const state = loadState();
      if (!state) {
        log.warn("POST /auth/login/options: no auth state — not set up");
        return json(res, 400, { error: "Not set up yet" });
      }

      const opts = await generateAuthOpts(state.credentials, rpID);
      storeChallenge(opts.challenge);
      json(res, 200, opts);
    }},

    { method: "POST", path: "/auth/login/verify", rateLimit: true, handler: async (req, res) => {
      const { origin, rpID } = getOriginAndRpID(req);
      log.info("POST /auth/login/verify: request received", {
        ip: req.socket.remoteAddress,
        origin, rpID,
        isLocal: isLocalRequest(req),
        isHttps: isHttpsConnection(req),
      });

      const { credential } = await parseJSON(req);

      const lockoutStatus = credentialLockout.isLocked(credential.id);
      if (lockoutStatus.locked) {
        log.warn("POST /auth/login/verify: credential locked out", {
          credentialId: credential.id,
          retryAfter: lockoutStatus.retryAfter,
        });
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
        log.warn("POST /auth/login/verify: authentication failed", {
          code: result.result.code,
          message: result.result.message,
          credentialId: credential.id,
        });
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
      log.info("POST /auth/login/verify: login complete");
      json(res, 200, { ok: true });
    }},

    // --- Logout / Revoke ---

    { method: "POST", path: "/auth/logout", handler: csrf(async (req, res) => {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.get("katulong_session");
      if (token) {
        try {
          const result = await withStateLock(async (state) => {
            if (state && state.isValidSession(token)) {
              return state.endSession(token, { allowRemoveLast: isLocalRequest(req) });
            }
            return { removedCredentialId: null };
          });

          if (result && result.removedCredentialId) {
            broadcastToAll({ type: 'credential-removed', credentialId: result.removedCredentialId });
            closeWebSocketsForCredential(result.removedCredentialId);
          }
        } catch (err) {
          if (err instanceof LastCredentialError) {
            return json(res, 403, { error: "Cannot end session for the last credential" });
          }
          throw err;
        }
      }
      let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
      if (isHttpsConnection(req)) clearCookie += "; Secure";
      res.setHeader("Set-Cookie", clearCookie);
      json(res, 200, { ok: true });
    })},

    { method: "POST", path: "/auth/revoke-all", handler: csrf(async (req, res) => {
      const state = loadState();
      if (!state) return json(res, 400, { error: "Not set up" });
      await withStateLock((currentState) => {
        if (!currentState) return {};
        return { state: currentState.revokeAllSessions() };
      });
      closeAllWebSockets(1008, "All sessions revoked");
      let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
      if (isHttpsConnection(req)) clearCookie += "; Secure";
      res.setHeader("Set-Cookie", clearCookie);
      json(res, 200, { ok: true });
    })},

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
        closeWebSocketsForCredential(removedCredentialId);
      }

      log.info("Credential revoked directly", { credentialId });
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

      const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
        closeWebSocketsForCredential(result.removedCredentialId);
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
  ];
}

// --- App routes ---

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated, daemonRPC,
    configManager, __dirname, DATA_DIR, SSH_PASSWORD, SSH_PORT, SSH_HOST, APP_VERSION,
    getDraining, getDaemonConnected,
    auth, csrf,
  } = ctx;

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
        return json(res, 503, { status: "draining", pid: process.pid });
      }
      json(res, 200, {
        status: "ok",
        pid: process.pid,
        uptime: process.uptime(),
        daemonConnected: getDaemonConnected(),
      });
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

      res.writeHead(200, {
        "Content-Type": "text/html",
        ...getCspHeaders(false, req, { flutter: true })
      });
      res.end(html);
    }},

    { method: "GET", path: "/manifest.json", handler: (req, res) => {
      const manifest = readFileSync(join(__dirname, "public", "manifest.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(manifest);
    }},

    { method: "GET", path: "/login", handler: (req, res) => {
      // Flutter handles /login via GoRouter — serve the same index.html
      let html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");

      // Inject CSRF token if user has an active session
      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies.get("katulong_session");
      if (sessionToken) {
        const state = loadState();
        const csrfToken = getCsrfToken(state, sessionToken);
        if (csrfToken) {
          html = html.replace("<head>", `<head>\n    <meta name="csrf-token" content="${escapeAttr(csrfToken)}">`);
        }
      }

      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        ...getCspHeaders(false, req, { flutter: true })
      });
      res.end(html);
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
      json(res, 200, { path: `/uploads/${filename}`, absolutePath: filePath });
    }))},

    // --- SSH / Connect ---

    { method: "GET", path: "/ssh/password", handler: auth((req, res) => {
      json(res, 200, { password: SSH_PASSWORD });
    })},

    { method: "GET", path: "/connect/info", handler: auth((req, res) => {
      json(res, 200, {
        sshPort: SSH_PORT,
        sshHost: SSH_HOST
      });
    })},

    // --- Shortcuts ---

    { method: "GET", path: "/shortcuts", handler: auth(async (req, res) => {
      const result = await daemonRPC({ type: "get-shortcuts" });
      json(res, 200, result.shortcuts);
    })},

    { method: "PUT", path: "/shortcuts", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const result = await daemonRPC({ type: "set-shortcuts", data });
      json(res, result.error ? 400 : 200, result.error ? { error: result.error } : { ok: true });
    }))},

    // --- Sessions ---

    { method: "GET", path: "/sessions", handler: auth(async (req, res) => {
      const result = await daemonRPC({ type: "list-sessions" });
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/sessions", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(name);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await daemonRPC({ type: "create-session", name: sessionName.toString() });
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
    }))},

    { method: "DELETE", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const result = await daemonRPC({ type: "delete-session", name });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true });
    }))},

    { method: "PUT", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const { name: newName } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(newName);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await daemonRPC({ type: "rename-session", oldName: name, newName: sessionName.toString() });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
    }))},

    // --- Config ---

    { method: "GET", path: "/api/config", handler: auth(async (req, res) => {
      const config = configManager.getConfig();
      json(res, 200, { config });
    })},

    configPutRoute("/api/config/instance-name", "instanceName", (v) => configManager.setInstanceName(v), () => configManager.getInstanceName()),
    configPutRoute("/api/config/instance-icon", "instanceIcon", (v) => configManager.setInstanceIcon(v), () => configManager.getInstanceIcon()),
    configPutRoute("/api/config/toolbar-color", "toolbarColor", (v) => configManager.setToolbarColor(v), () => configManager.getToolbarColor()),
  ];
}
