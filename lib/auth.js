/**
 * Auth
 *
 * WebAuthn registration/login, session token management, and auth queries.
 * Persistence (file I/O, caching, locking) is delegated to auth-repository.js.
 */

import { randomBytes } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { AuthState } from "./auth-state.js";
import { SESSION_TTL_MS } from "./env-config.js";
import { loadState, saveState, withStateLock } from "./auth-repository.js";

// Re-export persistence API for consumers that import from auth.js
export { loadState, saveState, _invalidateCache, withStateLock } from "./auth-repository.js";

export function isSetup() {
  const state = loadState();
  return state !== null && state.credentials && state.credentials.length > 0;
}

/**
 * Pull an api-key candidate string out of an incoming request, regardless
 * of whether the caller used a `Bearer` Authorization header or a
 * `?api_key=<key>` query param. Returns the raw candidate string, or null.
 *
 * Why both forms exist: native `fetch()` and most CLIs use the header
 * form, but `new WebSocket(url)` in browsers cannot set custom headers,
 * so the cross-instance-tile spike sends the key as a query param. Tests
 * pin both paths so we can never quietly lose support for either.
 *
 * Pure & framework-free — `req` only needs `headers.authorization`,
 * `headers.host`, and `url`. No state lookup happens here; callers
 * resolve the candidate against their auth store separately.
 */
export function extractApiKeyCandidate(req) {
  if (!req) return null;
  const authHeader = req.headers && req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token.length > 0 ? token : null;
  }
  if (typeof req.url === "string" && req.url.length > 0) {
    try {
      // The host header is just for URL parsing — the actual host
      // doesn't matter, we only care about the search params. But
      // `new URL` rejects a relative path with no base, so we have
      // to provide *some* base.
      const base = `http://${(req.headers && req.headers.host) || "x"}`;
      const u = new URL(req.url, base);
      const q = u.searchParams.get("api_key");
      if (q && q.length > 0) return q;
    } catch {
      /* malformed URL — fall through to null */
    }
  }
  return null;
}

export async function generateRegistrationOpts(rpName, rpID, existingUserID = null, deviceName = null) {
  const userID = existingUserID
    ? Buffer.from(existingUserID, "base64url")
    : randomBytes(16);
  const authenticatorSelection = {
    residentKey: "preferred",
    userVerification: "preferred",
  };
  // First device: force platform authenticator (Touch ID, Windows Hello).
  // Additional devices: omit authenticatorAttachment so the browser can offer
  // hybrid transport (QR code → phone passkey) and roaming authenticators
  // (security keys). This enables WebAuthn Cross-Device Authentication (CDA).
  if (!existingUserID) {
    authenticatorSelection.authenticatorAttachment = "platform";
  }
  const opts = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: deviceName || "Katulong Owner",
    userID,
    attestationType: "none",
    authenticatorSelection,
  });
  return { opts, userID: existingUserID || Buffer.from(userID).toString("base64url") };
}

export async function verifyRegistration(response, expectedChallenge, origin, rpID) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }
  const { credential } = verification.registrationInfo;
  return {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports || [],
  };
}

function ensureHybridTransport(transports) {
  const t = transports && transports.length > 0 ? [...transports] : ["internal"];
  if (!t.includes("hybrid")) t.push("hybrid");
  return t;
}

// Base64url: only A-Z, a-z, 0-9, -, _ (no padding required).
// Credential IDs must be at least 16 bytes (22 base64url chars).
const BASE64URL_RE = /^[A-Za-z0-9_-]{22,}$/;

export async function generateAuthOpts(credentials, rpID) {
  const valid = credentials.filter((c) => BASE64URL_RE.test(c.id));
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: valid.map((c) => ({
      id: c.id,
      // Always include "hybrid" so the browser offers QR code auth
      // for cross-device login (e.g. phone passkey → laptop).
      // Old credentials without stored transports get both.
      transports: ensureHybridTransport(c.transports),
    })),
    userVerification: "preferred",
  });
}

export async function verifyAuth(response, credential, expectedChallenge, origin, rpID) {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: credential.counter,
    },
  });
  if (!verification.verified) {
    throw new Error("Authentication verification failed");
  }
  return verification.authenticationInfo.newCounter;
}

export function createLoginToken() {
  const token = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiry = now + SESSION_TTL_MS;
  const lastActivityAt = now;
  return { token, csrfToken, expiry, lastActivityAt };
}

export function validateSession(state, token) {
  if (!state) return false;
  return state.isValidLoginToken(token);
}

/**
 * Refresh session activity (sliding expiry).
 * Called on each authenticated request to update lastActivityAt.
 */
export async function refreshSessionActivity(token) {
  if (!token) return;

  const state = loadState();
  if (!state) return;
  const loginToken = state.loginTokens?.[token];
  if (!loginToken) return;
  const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  if (loginToken.lastActivityAt && (Date.now() - loginToken.lastActivityAt) < REFRESH_THRESHOLD_MS) return;

  await withStateLock(async (freshState) => {
    if (!freshState) return {};
    if (!freshState.isValidLoginToken(token)) return {};
    return { state: freshState.updateLoginTokenActivity(token) };
  });
}

export function pruneExpiredSessions(state) {
  if (!state) return state;
  return state.pruneExpired();
}

