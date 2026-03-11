import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, renameSync, chmodSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { AuthState } from "./auth-state.js";
import { log } from "./log.js";
import envConfig, { SESSION_TTL_MS, ensureDataDir } from "./env-config.js";

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

// Validate that an entity ID is safe for use as a filename.
// Rejects path separators, .., null bytes, and empty strings.
function isSafeFilename(id) {
  return typeof id === 'string' && id.length > 0 &&
    !/[/\\\0]/.test(id) && !id.includes('..');
}

// Hash a value with SHA-256 for use as a filename.
// Prevents raw secrets from being exposed as filenames on disk.
function hashForFilename(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Sync a directory of entity files: write active items, delete removed ones.
// getFilename defaults to getId but can be overridden (e.g., to hash tokens).
function syncEntityDir(dir, items, getId, getFilename) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = new Set(readdirSync(dir).filter(f => f.endsWith(".json")));
  const active = new Set();
  const toFilename = getFilename || getId;
  for (const item of items) {
    const id = getId(item);
    const fname = toFilename(item);
    if (!isSafeFilename(id) || !isSafeFilename(fname)) {
      log.warn("Skipping entity with unsafe ID", { id: String(id).slice(0, 50) });
      continue;
    }
    const filename = `${fname}.json`;
    active.add(filename);
    atomicWriteJSON(join(dir, filename), item);
  }
  for (const file of existing) {
    if (!active.has(file)) unlinkSync(join(dir, file));
  }
}

export function loadState() {
  if (_cachedState !== undefined) return _cachedState;
  const { raw, fromMonolithic } = readStateFiles();
  if (raw === null) {
    _cachedState = null;
    return null;
  }
  try {
    const { state, needsSave } = migrateState(raw);
    if (needsSave || fromMonolithic) saveState(state);
    if (fromMonolithic) {
      try {
        const legacyPath = join(DATA_DIR, "katulong-auth.json");
        const backupPath = join(DATA_DIR, "katulong-auth.json.bak");
        if (existsSync(legacyPath)) {
          renameSync(legacyPath, backupPath);
          chmodSync(backupPath, 0o600);
          log.info("Renamed legacy katulong-auth.json to .bak after migration");
        }
      } catch {
        // Best-effort cleanup — migration already succeeded
      }
    }
    _cachedState = state;
    return _cachedState;
  } catch (err) {
    log.error(`Failed to parse auth state`, { path: DATA_DIR, error: err.message });
    _cachedState = null;
    return null;
  }
}

// Assemble auth state from per-entity files. Returns null if not set up.
// Falls back to monolithic katulong-auth.json if per-entity files don't exist.
function readStateFiles() {
  const userPath = join(DATA_DIR, "user.json");
  if (!existsSync(userPath)) {
    // Fallback: migrate from monolithic katulong-auth.json
    return readMonolithicState();
  }

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

    return { raw: { user, credentials, sessions, setupTokens }, fromMonolithic: false };
  } catch (err) {
    log.error(`Failed to read auth state files`, { path: DATA_DIR, error: err.message });
    return { raw: null, fromMonolithic: false };
  }
}

// Read legacy monolithic katulong-auth.json and migrate to per-entity files.
function readMonolithicState() {
  const legacyPath = join(DATA_DIR, "katulong-auth.json");
  if (!existsSync(legacyPath)) return { raw: null, fromMonolithic: false };

  try {
    const data = JSON.parse(readFileSync(legacyPath, "utf-8"));
    if (!data || (!data.credentials?.length && !data.setupTokens?.length)) {
      return { raw: null, fromMonolithic: false };
    }

    log.info("Migrating from monolithic katulong-auth.json to per-entity files");

    return {
      raw: {
        user: data.user || null,
        credentials: data.credentials || [],
        sessions: data.sessions || {},
        setupTokens: data.setupTokens || [],
      },
      fromMonolithic: true,
    };
  } catch (err) {
    log.error("Failed to read monolithic auth state", { path: legacyPath, error: err.message });
    return { raw: null, fromMonolithic: false };
  }
}

// Applies all migration phases to raw parsed state data.
// Returns { state: AuthState, needsSave: boolean }.
function migrateState(raw) {
  const now = Date.now();
  let needsSave = false;

  const { state: parsedState, needsMigration: tokensMigrated } = AuthState.fromJSON(raw);
  let state = parsedState;

  if (tokensMigrated) {
    log.info('Migrated plaintext setup tokens to hashed format');
    needsSave = true;
  }

  const credResult = state.migrateCredentialMetadata(now);
  if (credResult.migrated) {
    state = credResult.state;
    log.info('Migrated credentials to include device metadata');
    needsSave = true;
  }

  const sessionResult = state.cleanOrphanedSessions();
  if (sessionResult.cleaned) {
    state = sessionResult.state;
    log.info('Cleaned up orphaned sessions');
    needsSave = true;
  }

  const activityResult = state.migrateSessionActivity(now);
  if (activityResult.migrated) {
    state = activityResult.state;
    log.info('Added lastActivityAt to existing sessions');
    needsSave = true;
  }

  const setupTokensBeforeCleanup = state.setupTokens.length;
  state = state.pruneExpiredTokens(now);
  if (state.setupTokens.length !== setupTokensBeforeCleanup) {
    log.info('Cleaned up expired setup tokens', { removed: setupTokensBeforeCleanup - state.setupTokens.length });
    needsSave = true;
  }

  return { state, needsSave };
}

export function saveState(state) {
  const json = state instanceof AuthState ? state.toJSON() : state;
  _cachedState = state instanceof AuthState ? state : AuthState.fromJSON(state).state;

  ensureDataDir();

  // Write user.json (always write so per-entity format is established)
  atomicWriteJSON(join(DATA_DIR, "user.json"), json.user || null);

  // Sync credentials/
  syncEntityDir(
    join(DATA_DIR, "credentials"),
    json.credentials || [],
    (c) => c.id
  );

  // Sync sessions/ — token stored inside file, filename is SHA-256(token)
  // This prevents raw session tokens from being exposed as filenames on disk.
  const sessionEntries = Object.entries(json.sessions || {}).map(
    ([token, session]) => ({ token, ...session })
  );
  syncEntityDir(
    join(DATA_DIR, "sessions"),
    sessionEntries,
    (s) => s.token,
    (s) => hashForFilename(s.token)
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

export async function generateRegistrationOpts(rpName, rpID, existingUserID = null) {
  const userID = existingUserID
    ? Buffer.from(existingUserID, "base64url")
    : randomBytes(16);
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

  // Check threshold before acquiring lock to avoid unnecessary I/O on every request
  const state = loadState();
  if (!state) return;
  const session = state.sessions?.[token];
  if (!session) return;
  const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  if (session.lastActivityAt && (Date.now() - session.lastActivityAt) < REFRESH_THRESHOLD_MS) return;

  await withStateLock(async (freshState) => {
    if (!freshState) return {};
    if (!freshState.isValidSession(token)) return {};
    return { state: freshState.updateSessionActivity(token) };
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
