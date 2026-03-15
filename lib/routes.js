/**
 * HTTP Routes
 *
 * All route definitions: middleware, auth, and app routes in a single module.
 * Consolidated from lib/routes/middleware.js, lib/routes/auth.js, and lib/routes/app.js.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  loadState, isSetup, withStateLock,
  generateRegistrationOpts,
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
import { SETUP_TOKEN_TTL_MS } from "./env-config.js";
import { SessionName } from "./session-name.js";
import { loadShortcuts, saveShortcuts } from "./shortcuts.js";
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

import { readRawBody } from "./request-util.js";

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
  ];
}

// --- App routes ---

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated, sessionManager,
    helmSessionManager,
    configManager, __dirname, DATA_DIR, APP_VERSION, rewriteVendorUrls,
    getDraining, shortcutsPath,
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
      if (rewriteVendorUrls) html = rewriteVendorUrls(html);

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
      if (rewriteVendorUrls) loginHtml = rewriteVendorUrls(loginHtml);
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

      // Copy image to host system clipboard so CLI tools (Claude Code) can read it via Ctrl+V.
      // On macOS, use osascript to set the native clipboard — Claude Code reads it natively.
      // On Linux (e.g., inside a kubo container), there's no system clipboard. Instead,
      // return clipboard=false so the browser sends the filesystem path as text, which
      // Claude Code can read directly as a file path.
      let clipboard = false;
      if (process.platform === "darwin") {
        const applescriptType = ext === "png" ? "«class PNGf»" : ext === "gif" ? "«class GIFf»" : "«class JPEG»";
        try {
          await new Promise((resolve, reject) => {
            execFile("osascript", ["-e", `set the clipboard to (read (POSIX file "${filePath}") as ${applescriptType})`],
              { timeout: 5000 }, (err) => err ? reject(err) : resolve());
          });
          clipboard = true;
        } catch (err) {
          log.warn("Failed to copy image to clipboard", { error: err.message });
        }
      }
      // Linux: clipboard stays false — fsPath fallback sends the path as text

      json(res, 200, { path: `/uploads/${filename}`, fsPath: filePath, clipboard });
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
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
    }))},

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

    configPutRoute("/api/config/instance-name", "instanceName", (v) => configManager.setInstanceName(v), () => configManager.getInstanceName()),
    configPutRoute("/api/config/instance-icon", "instanceIcon", (v) => configManager.setInstanceIcon(v), () => configManager.getInstanceIcon()),
    configPutRoute("/api/config/toolbar-color", "toolbarColor", (v) => configManager.setToolbarColor(v), () => configManager.getToolbarColor()),
    configPutRoute("/api/config/port-proxy-enabled", "portProxyEnabled", (v) => configManager.setPortProxyEnabled(v), () => configManager.getPortProxyEnabled()),
  ];
}
