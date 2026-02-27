/**
 * Auth Handler Business Logic - Functional Core
 *
 * Pure functions that encapsulate auth handler business logic.
 * All I/O (HTTP, state persistence) is handled by the caller (imperative shell).
 */

import { verifyRegistration, verifyAuth, createSession } from "./auth.js";
import { AuthState } from "./auth-state.js";
import { Success, Failure } from "./result.js";

/**
 * Extract challenge from WebAuthn credential response
 * @param {object} credential - WebAuthn credential response
 * @returns {string} Challenge string
 */
export function extractChallenge(credential) {
  const clientData = JSON.parse(
    Buffer.from(credential.response.clientDataJSON, "base64url").toString()
  );
  return clientData.challenge;
}

/**
 * Process WebAuthn registration - functional core
 *
 * Note: Setup token validation is performed by the caller (in /auth/register/options)
 *
 * @param {object} params
 * @param {object} params.credential - WebAuthn credential response
 * @param {string} params.challenge - Challenge extracted from credential
 * @param {boolean} params.challengeValid - Whether challenge was successfully consumed
 * @param {string} params.userID - User ID associated with registration
 * @param {string} params.origin - Request origin
 * @param {string} params.rpID - Relying party ID
 * @param {object} params.currentState - Current auth state (or null)
 * @param {string} params.deviceId - Client-provided stable device ID
 * @param {string} params.deviceName - Device name (auto-generated from UA)
 * @param {string} params.userAgent - Browser/device user agent
 * @param {string} params.setupTokenId - Optional setup token ID that was used for this registration
 * @returns {Promise<Success|Failure>}
 */
export async function processRegistration({
  credential,
  challenge,
  challengeValid,
  userID,
  origin,
  rpID,
  currentState,
  deviceId,
  deviceName,
  userAgent,
  setupTokenId = null,
}) {
  // Validate challenge
  if (!challengeValid) {
    return new Failure("invalid-challenge", "Challenge expired or invalid", 400);
  }

  try {
    // Verify WebAuthn registration
    const cred = await verifyRegistration(credential, challenge, origin, rpID);

    // Enrich credential with metadata
    const now = Date.now();
    const enrichedCred = {
      ...cred,
      deviceId: deviceId || null,
      name: deviceName || 'Unknown Device',
      createdAt: now,
      lastUsedAt: now,
      userAgent: userAgent || 'Unknown',
      setupTokenId: setupTokenId || null, // Link to setup token if provided
    };

    // Create new session
    const session = createSession();

    // Build updated state immutably
    let state = currentState;
    if (!state) {
      // First device: create new state
      state = AuthState.empty(userID);
    }

    const updatedState = state
      .pruneExpired()
      .addCredential(enrichedCred)
      .addSession(session.token, session.expiry, enrichedCred.id, session.csrfToken, session.lastActivityAt);

    return new Success({ session, updatedState, credentialId: enrichedCred.id });
  } catch (err) {
    return new Failure("verification-failed", err.message, 400);
  }
}

/**
 * Process WebAuthn authentication - functional core
 *
 * @param {object} params
 * @param {object} params.credential - WebAuthn credential response
 * @param {string} params.challenge - Challenge extracted from credential
 * @param {boolean} params.challengeValid - Whether challenge was successfully consumed
 * @param {string} params.origin - Request origin
 * @param {string} params.rpID - Relying party ID
 * @param {object} params.currentState - Current auth state
 * @returns {Promise<Success|Failure>}
 */
export async function processAuthentication({
  credential,
  challenge,
  challengeValid,
  origin,
  rpID,
  currentState,
}) {
  // Check if setup
  if (!currentState) {
    return new Failure("not-setup", "Not set up yet", 400);
  }

  // Find matching credential
  const storedCred = currentState.credentials.find((c) => c.id === credential.id);
  if (!storedCred) {
    return new Failure("unknown-credential", "Unknown credential", 400);
  }

  // Validate challenge
  if (!challengeValid) {
    return new Failure("invalid-challenge", "Challenge expired or invalid", 400);
  }

  try {
    // Verify WebAuthn authentication
    const newCounter = await verifyAuth(credential, storedCred, challenge, origin, rpID);

    // Create new session
    const session = createSession();

    // Build updated state immutably — use updateCredential() so the counter
    // update goes through the AuthState immutable API instead of mutating the
    // cached credential object in-place.
    const updatedState = currentState
      .pruneExpired()
      .updateCredential(storedCred.id, { counter: newCounter, lastUsedAt: Date.now() })
      .addSession(session.token, session.expiry, storedCred.id, session.csrfToken, session.lastActivityAt);

    return new Success({ session, updatedState });
  } catch (err) {
    return new Failure("verification-failed", err.message, 400);
  }
}
