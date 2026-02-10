import { readFileSync, writeFileSync, existsSync, watch, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { AuthState } from "./auth-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.KATULONG_DATA_DIR || join(__dirname, "..");
const STATE_PATH = join(DATA_DIR, "katulong-auth.json");

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let _cachedState = undefined; // undefined = not loaded yet, null = no file
let _stateLock = Promise.resolve(); // Simple async mutex for state modifications

// Watch the directory so invalidation works even before the file exists.
try {
  const watcher = watch(DATA_DIR, (_, filename) => {
    if (filename === "katulong-auth.json") _cachedState = undefined;
  });
  watcher.unref();
} catch {
  // Directory may not exist yet; loadState handles it
}

export function loadState() {
  if (_cachedState !== undefined) return _cachedState;
  if (!existsSync(STATE_PATH)) {
    _cachedState = null;
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    let state = AuthState.fromJSON(data);

    // Migration: Enrich credentials without metadata
    let needsMigration = false;
    const now = Date.now();
    const migratedCredentials = state.credentials.map((cred, index) => {
      // Check if credential already has metadata
      if (cred.deviceId !== undefined && cred.name !== undefined) {
        return cred; // Already migrated
      }

      needsMigration = true;
      return {
        ...cred,
        deviceId: cred.deviceId || null, // No stable ID for old credentials
        name: cred.name || `Device ${index + 1}`,
        createdAt: cred.createdAt || now,
        lastUsedAt: cred.lastUsedAt || now,
        userAgent: cred.userAgent || 'Unknown',
      };
    });

    if (needsMigration) {
      state = new AuthState({
        user: state.user,
        credentials: migratedCredentials,
        sessions: state.sessions,
      });
      console.log('Migrated credentials to include device metadata');
    }

    // Migration: Remove orphaned sessions (sessions for non-existent credentials)
    const validCredentialIds = new Set(state.credentials.map(c => c.id));
    let needsSessionCleanup = false;
    const cleanedSessions = Object.fromEntries(
      Object.entries(state.sessions).filter(([_, session]) => {
        // Remove old format sessions (just a number)
        if (typeof session === 'number') {
          needsSessionCleanup = true;
          return false;
        }
        // Remove old object sessions that don't have credentialId property at all
        // (created before credentialId tracking was added)
        if (!('credentialId' in session)) {
          needsSessionCleanup = true;
          return false;
        }
        // Keep pairing sessions (credentialId explicitly set to null)
        if (session.credentialId === null) {
          return true;
        }
        // Remove sessions for credentials that no longer exist
        if (!validCredentialIds.has(session.credentialId)) {
          needsSessionCleanup = true;
          return false;
        }
        return true;
      })
    );

    if (needsSessionCleanup) {
      state = new AuthState({
        user: state.user,
        credentials: state.credentials,
        sessions: cleanedSessions,
      });
      console.log('Cleaned up orphaned sessions');
    }

    // Save migrated state if any changes were made
    if (needsMigration || needsSessionCleanup) {
      saveState(state);
    }

    _cachedState = state;
    return _cachedState;
  } catch (err) {
    // Corrupt JSON - log error and treat as if file doesn't exist
    console.error(`Failed to parse ${STATE_PATH}: ${err.message}. Starting with fresh state.`);
    _cachedState = null;
    return null;
  }
}

export function saveState(state) {
  const json = state instanceof AuthState ? state.toJSON() : state;
  _cachedState = state instanceof AuthState ? state : AuthState.fromJSON(state);
  // Atomic write: write to temp file then rename (prevents corruption on crash)
  const tempPath = `${STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(json, null, 2), "utf-8");
  renameSync(tempPath, STATE_PATH);
}

export function _invalidateCache() {
  _cachedState = undefined;
}

export function isSetup() {
  return loadState() !== null;
}

export async function generateRegistrationOpts(rpName, rpID, origin) {
  const userID = randomBytes(16);
  const opts = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: "Owner",
    userID,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return { opts, userID: Buffer.from(userID).toString("base64url") };
}

export async function generateRegistrationOptsForUser(existingUserID, rpName, rpID, origin) {
  const userID = Buffer.from(existingUserID, "base64url");
  const opts = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: "Owner",
    userID,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return { opts, userID: existingUserID };
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
  };
}

export async function generateAuthOpts(credentials, rpID) {
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((c) => ({ id: c.id })),
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

export function createSession() {
  const token = randomBytes(32).toString("hex");
  const expiry = Date.now() + SESSION_TTL_MS;
  return { token, expiry };
}

export function validateSession(state, token) {
  if (!state) return false;
  if (state instanceof AuthState) {
    return state.isValidSession(token);
  }
  // Backward compatibility with plain objects
  if (!token) return false;
  const session = state.sessions?.[token];
  if (!session) return false;
  const expiry = typeof session === 'number' ? session : session.expiry;
  return Date.now() < expiry;
}

export function pruneExpiredSessions(state) {
  if (!state) return state;
  if (state instanceof AuthState) {
    return state.pruneExpired();
  }
  // Backward compatibility with plain objects
  if (!state.sessions) return state;
  const now = Date.now();
  for (const [token, expiry] of Object.entries(state.sessions)) {
    if (now >= expiry) delete state.sessions[token];
  }
  return state;
}

export function revokeAllSessions(state) {
  if (!state) return state;
  if (state instanceof AuthState) {
    const newState = state.revokeAllSessions();
    saveState(newState);
    return newState;
  }
  // Backward compatibility with plain objects
  state.sessions = {};
  saveState(state);
  return state;
}

/**
 * Safely modify auth state with mutex locking to prevent race conditions.
 * Usage: await withStateLock(async (state) => { modify state; return state; });
 */
export async function withStateLock(modifier) {
  // Chain this operation after the previous one completes
  const operation = _stateLock.then(async () => {
    let state = loadState();
    state = await modifier(state);
    saveState(state);
    return state;
  });
  _stateLock = operation.catch(() => {}); // Swallow errors for next operation
  return operation;
}
