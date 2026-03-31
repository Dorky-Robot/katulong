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

export async function generateRegistrationOpts(rpName, rpID, existingUserID = null) {
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
    userDisplayName: "Owner",
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

export async function generateAuthOpts(credentials, rpID) {
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((c) => ({
      id: c.id,
      transports: c.transports || ["internal"],
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

