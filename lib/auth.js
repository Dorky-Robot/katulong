import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { AuthState } from "./auth-state.js";
import { log } from "./log.js";
import { SESSION_TTL_MS } from "./constants.js";
import envConfig from "./env-config.js";

const DATA_DIR = envConfig.dataDir;

let _cachedState = undefined; // undefined = not loaded yet, null = no file
let _stateLock = Promise.resolve(); // Simple async mutex for state modifications

// Read all JSON files from a directory, returning parsed objects.
// Silently skips corrupt files.
function readEntityDir(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      items.push(JSON.parse(readFileSync(join(dir, file), "utf-8")));
    } catch (err) {
      log.error(`Failed to parse ${join(dir, file)}`, { error: err.message });
    }
  }
  return items;
}

// Atomic write: temp file + rename (prevents corruption on crash).
// mode 0o600: owner read/write only.
function atomicWriteJSON(filePath, data) {
  const tempPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tempPath, filePath);
}

// Sync a directory of entity files: write active items, delete removed ones.
function syncEntityDir(dir, items, getId) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = new Set(readdirSync(dir).filter(f => f.endsWith(".json")));
  const active = new Set();
  for (const item of items) {
    const filename = `${getId(item)}.json`;
    active.add(filename);
    atomicWriteJSON(join(dir, filename), item);
  }
  for (const file of existing) {
    if (!active.has(file)) unlinkSync(join(dir, file));
  }
}

export function loadState() {
  if (_cachedState !== undefined) return _cachedState;
  const raw = readStateFiles();
  if (raw === null) {
    _cachedState = null;
    return null;
  }
  try {
    const { state, needsSave } = migrateState(raw);
    if (needsSave) saveState(state);
    _cachedState = state;
    return _cachedState;
  } catch (err) {
    log.error(`Failed to parse auth state`, { path: DATA_DIR, error: err.message });
    _cachedState = null;
    return null;
  }
}

// Assemble auth state from per-entity files. Returns null if not set up.
function readStateFiles() {
  const userPath = join(DATA_DIR, "user.json");
  if (!existsSync(userPath)) return null;

  try {
    const user = JSON.parse(readFileSync(userPath, "utf-8"));
    const credentials = readEntityDir(join(DATA_DIR, "credentials"));
    const sessionItems = readEntityDir(join(DATA_DIR, "sessions"));
    const setupTokens = readEntityDir(join(DATA_DIR, "setup-tokens"));

    // Convert session array to { [token]: session } object
    const sessions = {};
    for (const item of sessionItems) {
      const { token, ...session } = item;
      if (token) sessions[token] = session;
    }

    return { user, credentials, sessions, setupTokens };
  } catch (err) {
    log.error(`Failed to read auth state files`, { path: DATA_DIR, error: err.message });
    return null;
  }
}

// Applies all migration phases to raw parsed state data.
// Returns { state: AuthState, needsSave: boolean }.
function migrateState(raw) {
  const now = Date.now();
  let needsSave = false;

  const { state: parsedState, needsMigration: tokensMigrated } = AuthState.fromJSON(raw);
  let state = parsedState;

  // Migration: fromJSON detects and hashes plaintext setup tokens.
  // needsMigration is returned explicitly so migration is visible to the caller.
  if (tokensMigrated) {
    log.info('Migrated plaintext setup tokens to hashed format');
    needsSave = true;
  }

  // Migration: Enrich credentials missing device metadata
  let needsCredentialMigration = false;
  const migratedCredentials = state.credentials.map((cred, index) => {
    // Check if credential already has metadata
    if (cred.deviceId !== undefined && cred.name !== undefined) {
      return cred; // Already migrated
    }
    needsCredentialMigration = true;
    return {
      ...cred,
      deviceId: cred.deviceId || null, // No stable ID for old credentials
      name: cred.name || `Device ${index + 1}`,
      createdAt: cred.createdAt || now,
      lastUsedAt: cred.lastUsedAt || now,
      userAgent: cred.userAgent || 'Unknown',
    };
  });

  if (needsCredentialMigration) {
    state = new AuthState({
      user: state.user,
      credentials: migratedCredentials,
      sessions: state.sessions,
      setupTokens: state.setupTokens,
    });
    log.info('Migrated credentials to include device metadata');
    needsSave = true;
  }

  // Migration: Remove orphaned sessions (sessions for non-existent credentials)
  const validCredentialIds = new Set(state.credentials.map(c => c.id));
  let needsSessionCleanup = false;
  const cleanedSessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([_, session]) => {
      // Remove old format sessions (just a number)
      if (typeof session === 'number') { needsSessionCleanup = true; return false; }
      // Remove old object sessions that don't have credentialId property at all
      // (created before credentialId tracking was added)
      if (!('credentialId' in session)) { needsSessionCleanup = true; return false; }
      // Remove old pairing sessions (credentialId: null)
      // Pairing now creates credentials, so null is invalid
      if (session.credentialId === null) { needsSessionCleanup = true; return false; }
      // Remove sessions for credentials that no longer exist
      if (!validCredentialIds.has(session.credentialId)) { needsSessionCleanup = true; return false; }
      return true;
    })
  );

  if (needsSessionCleanup) {
    state = new AuthState({
      user: state.user,
      credentials: state.credentials,
      sessions: cleanedSessions,
      setupTokens: state.setupTokens,
    });
    log.info('Cleaned up orphaned sessions');
    needsSave = true;
  }

  // Migration: Add lastActivityAt to sessions that don't have it (for sliding expiry)
  let needsActivityMigration = false;
  const migratedSessions = Object.fromEntries(
    Object.entries(state.sessions).map(([token, session]) => {
      if (!session.lastActivityAt) {
        needsActivityMigration = true;
        // Use current time as lastActivityAt for existing sessions
        return [token, { ...session, lastActivityAt: now }];
      }
      return [token, session];
    })
  );

  if (needsActivityMigration) {
    state = new AuthState({
      user: state.user,
      credentials: state.credentials,
      sessions: migratedSessions,
      setupTokens: state.setupTokens,
    });
    log.info('Added lastActivityAt to existing sessions');
    needsSave = true;
  }

  // Cleanup: Remove expired setup tokens (fail-closed: tokens without expiresAt are treated as expired)
  const setupTokensBeforeCleanup = state.setupTokens.length;
  state = state.pruneExpiredTokens(now);
  const needsTokenCleanup = state.setupTokens.length !== setupTokensBeforeCleanup;
  if (needsTokenCleanup) {
    log.info('Cleaned up expired setup tokens', { removed: setupTokensBeforeCleanup - state.setupTokens.length });
    needsSave = true;
  }

  return { state, needsSave };
}

export function saveState(state) {
  const json = state instanceof AuthState ? state.toJSON() : state;
  _cachedState = state instanceof AuthState ? state : AuthState.fromJSON(state).state;

  // Write user.json
  if (json.user) {
    atomicWriteJSON(join(DATA_DIR, "user.json"), json.user);
  }

  // Sync credentials/
  syncEntityDir(
    join(DATA_DIR, "credentials"),
    json.credentials || [],
    (c) => c.id
  );

  // Sync sessions/ — include token in the file content
  const sessionEntries = Object.entries(json.sessions || {}).map(
    ([token, session]) => ({ token, ...session })
  );
  syncEntityDir(
    join(DATA_DIR, "sessions"),
    sessionEntries,
    (s) => s.token
  );

  // Sync setup-tokens/
  syncEntityDir(
    join(DATA_DIR, "setup-tokens"),
    json.setupTokens || [],
    (t) => t.id
  );
}

export function _invalidateCache() {
  _cachedState = undefined;
}

export function isSetup() {
  const state = loadState();
  return state !== null && state.credentials && state.credentials.length > 0;
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
      authenticatorAttachment: "platform", // Prefer built-in authenticators (Touch ID, Windows Hello, etc.)
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
      authenticatorAttachment: "platform", // Prefer built-in authenticators (Touch ID, Windows Hello, etc.)
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
    allowCredentials: credentials.map((c) => ({
      id: c.id,
      transports: ["internal"], // Platform authenticators only
    })),
    userVerification: "preferred",
    // Note: authenticatorAttachment is not available for authentication,
    // but we can limit to platform authenticators via transports: ["internal"]
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
  const csrfToken = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiry = now + SESSION_TTL_MS;
  const lastActivityAt = now;
  return { token, csrfToken, expiry, lastActivityAt };
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

/**
 * Refresh session activity (sliding expiry)
 * Should be called on each authenticated request to update lastActivityAt
 * and potentially extend session expiry.
 *
 * @param {string} token - Session token
 * @returns {Promise<void>}
 */
export async function refreshSessionActivity(token) {
  if (!token) return;

  await withStateLock(async (state) => {
    if (!state) return {};
    if (!state.isValidSession(token)) return {};

    // Update session activity (will extend expiry if threshold exceeded)
    return { state: state.updateSessionActivity(token) };
  });
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
 * Safely modify auth state with in-process mutex to prevent race conditions.
 *
 * The modifier must return a plain object. To save state changes, include a
 * `state` key with the new AuthState. To perform a read-only query, return an
 * object without a `state` key.
 *
 * Usage:
 *   // Modifier with state change:
 *   await withStateLock(async (state) => ({
 *     state: state.addCredential(cred)
 *   }));
 *
 *   // Modifier with state change and extra data:
 *   const { result } = await withStateLock(async (state) => ({
 *     state: state.addCredential(cred),
 *     result: { session, ... }
 *   }));
 *
 *   // Read-only query (no state key → no save):
 *   const { found } = await withStateLock(async (state) => ({
 *     found: state.hasCredentials()
 *   }));
 */
export async function withStateLock(modifier) {
  // Chain this operation after the previous one completes (in-process mutex)
  const operation = _stateLock.then(async () => {
    // Force cache re-read to prevent stale reads
    _cachedState = undefined;
    let state = loadState();
    const result = await modifier(state);

    // Single contract: { state?, ...data }
    // If state key is present and non-null, save it. Otherwise skip saving.
    if (result && typeof result === 'object' && 'state' in result && result.state != null) {
      saveState(result.state);
    }
    return result;
  });
  _stateLock = operation.catch((err) => {
    // Swallow errors so the mutex chain continues for subsequent operations.
    // Log at warn level so failures are visible without blocking callers.
    log.warn("withStateLock operation failed", { error: err?.message || String(err) });
  });
  return operation;
}
