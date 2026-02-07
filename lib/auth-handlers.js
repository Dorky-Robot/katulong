/**
 * Auth Handler Business Logic - Functional Core
 *
 * Pure functions that encapsulate auth handler business logic.
 * All I/O (HTTP, state persistence) is handled by the caller (imperative shell).
 */

import { verifyRegistration, verifyAuth, createSession } from "./auth.js";
import { AuthState } from "./auth-state.js";
import { Success, Failure } from "./result.js";

// Re-export for backward compatibility and convenience
export const AuthSuccess = Success;
export const AuthFailure = Failure;

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
 * @param {object} params
 * @param {object} params.credential - WebAuthn credential response
 * @param {string} params.setupToken - Setup token from request
 * @param {string} params.expectedSetupToken - Expected setup token
 * @param {string} params.challenge - Challenge extracted from credential
 * @param {boolean} params.challengeValid - Whether challenge was successfully consumed
 * @param {string} params.userID - User ID associated with registration
 * @param {string} params.origin - Request origin
 * @param {string} params.rpID - Relying party ID
 * @param {object} params.currentState - Current auth state (or null)
 * @returns {Promise<Success|Failure>}
 */
export async function processRegistration({
  credential,
  setupToken,
  expectedSetupToken,
  challenge,
  challengeValid,
  userID,
  origin,
  rpID,
  currentState,
}) {
  // Validate setup token
  if (setupToken !== expectedSetupToken) {
    return new Failure("invalid-setup-token", "Invalid setup token", 403);
  }

  // Validate challenge
  if (!challengeValid) {
    return new Failure("invalid-challenge", "Challenge expired or invalid", 400);
  }

  try {
    // Verify WebAuthn registration
    const cred = await verifyRegistration(credential, challenge, origin, rpID);

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
      .addCredential(cred)
      .addSession(session.token, session.expiry);

    return new Success({ session, updatedState });
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

    // Update counter (mutation is OK here since we'll create new state object)
    storedCred.counter = newCounter;

    // Create new session
    const session = createSession();

    // Build updated state immutably
    const updatedState = currentState
      .pruneExpired()
      .addSession(session.token, session.expiry);

    return new Success({ session, updatedState });
  } catch (err) {
    return new Failure("verification-failed", err.message, 400);
  }
}

/**
 * Process device pairing - functional core
 *
 * @param {object} params
 * @param {object} params.pairingResult - Result from pairingStore.consume()
 * @param {object} params.currentState - Current auth state (or null)
 * @returns {Success|Failure}
 */
export function processPairing({ pairingResult, currentState }) {
  if (!pairingResult.valid) {
    // Map internal reasons to user-facing errors
    const errorMessages = {
      "invalid-code-format": "Invalid code format",
      "missing-pin": "Missing code or PIN",
      "not-found": "Invalid or expired pairing code",
      "expired": "Pairing code expired",
      "invalid-format": "PIN must be exactly 6 digits",
      "wrong-pin": "Invalid PIN",
    };

    const statusCodes = {
      "invalid-code-format": 400,
      "missing-pin": 400,
      "not-found": 400,
      "expired": 400,
      "invalid-format": 400,
      "wrong-pin": 403,
    };

    const message = errorMessages[pairingResult.reason] || "Pairing failed";
    const statusCode = statusCodes[pairingResult.reason] || 400;

    return new Failure(pairingResult.reason, message, statusCode);
  }

  // Create new session
  const session = createSession();

  // Build updated state immutably
  let state = currentState;
  if (!state) {
    state = AuthState.empty("paired-user");
  }

  const updatedState = state
    .pruneExpired()
    .addSession(session.token, session.expiry);

  return new Success({ session, updatedState });
}
