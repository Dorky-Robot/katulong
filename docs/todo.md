# Katulong Simplification Plan

Inspired by the Raptor 1 -> Raptor 3 philosophy: delete parts, simplify, make fewer things do more.
Based on a full codebase review by 8 design perspectives (Hickey, Kay, Evans, FP, Armstrong, Metz, Lamport, Beck).

## Tier 1: Critical Fixes (bugs & safety)

### 1.1 Fix concurrent attach race condition
- **Problem**: Two simultaneous attaches to the same nonexistent session spawn two tmux control processes, breaking the first (Lamport)
- **Scope**: `lib/session-manager.js` — `attachClient`, `spawnSession`
- **Plan**:
  - Add a `pendingSpawns` Map holding in-flight spawn Promises keyed by session name
  - In `attachClient`, if a spawn is pending, await it instead of spawning again
  - Clean up pending entry on completion/failure
- **Verify**: `npm test` + new concurrent attach test
- [x] Done

### 1.2 Fix TOCTOU in adoptTmuxSession
- **Problem**: Losing caller's `detachControlProc` kills the winner's control pipe via `-d` flag race (Lamport)
- **Scope**: `lib/session-manager.js` — `adoptTmuxSession`
- **Plan**: Serialize adopt calls per session name using the same `pendingSpawns` mechanism from 1.1
- **Verify**: `npm test`
- [x] Done

### 1.3 Add WebSocket ping/pong heartbeat
- **Problem**: Orphaned connections accumulate silently on network drops — no liveness detection (Armstrong)
- **Scope**: `lib/ws-manager.js`
- **Plan**:
  - 30s ping interval per WebSocket connection
  - Track pong responses; terminate after 2 missed pongs
  - Existing `close` handler cleans up client state
- **Verify**: `npm test` + manual network disconnect test
- [x] Done

### 1.4 Let unhandled rejections crash the process
- **Problem**: Swallowing rejections hides bugs, prevents clean restart. tmux sessions survive restarts by design (Armstrong)
- **Scope**: `server.js` lines 343-345
- **Plan**: Change handler to log at error level then `process.exit(1)`
- **Verify**: `npm test` + verify graceful shutdown
- [x] Done

### 1.5 Add expired auth session pruning timer
- **Problem**: Expired sessions accumulate on disk indefinitely without login activity (Lamport)
- **Scope**: `server.js`, `lib/auth.js`
- **Plan**: 1-hour `setInterval` calling `withStateLock` + `pruneExpired`. `unref()` the timer.
- **Verify**: `npm test` + unit test for pruning
- [x] Done

## Tier 2: Cleanup & Simplification

### 2.1 Extract shortcuts from SessionManager
- **Problem**: Shortcuts have nothing to do with terminal sessions — bounded context violation (Evans, Metz)
- **Scope**: `lib/session-manager.js`, `lib/routes.js`, `server.js`
- **Plan**:
  - Create shortcut routes that call `loadShortcuts`/`saveShortcuts` directly
  - Remove `getShortcuts`/`setShortcuts` from session manager
- **Verify**: `npm test`
- [x] Done

### 2.2 Delete duplicate readRawBody
- **Problem**: Two identical implementations — security risk of divergence (Beck)
- **Scope**: `lib/routes.js` lines 52-68
- **Plan**: Import from `lib/request-util.js`, delete inlined copy. Keep `detectImage` local.
- **Verify**: `npm test`
- [x] Done

### 2.3 Simplify Result type & unify error protocol
- **Problem**: Full monad API unused (`map`/`flatMap`/`unwrap` never called). Two incompatible error dialects: `Result` in auth-handlers vs `{ error }` objects in session-manager (Beck, FP, Evans, Kay)
- **Scope**: `lib/result.js`, `lib/session-manager.js`, `lib/routes.js`
- **Plan**:
  - Trim `result.js` — remove unused `map`/`flatMap`/`unwrap`/`unwrapOr`/factory functions
  - Adopt `Result` in session manager's public API
  - Update routes to use `.success` checks consistently
- **Verify**: `npm test`
- [x] Done

### 2.4 Replace bare `catch {}` blocks with logged errors
- **Problem**: Silent failures hide bugs — input drops, session errors go undetected (Armstrong)
- **Scope**: `lib/session-manager.js` (writeInput, resizeClient), grep for bare catch elsewhere
- **Plan**: Add `log.warn` with context for each bare catch
- **Verify**: `npm test`
- [x] Done

## Tier 3: Structural Improvements

### 3.1 Narrow routeCtx — split routes.js by concern
- **Problem**: 692-line god module, 18-field grab bag passed to every route factory (Hickey, Kay, Metz, Beck — 4 agents flagged this)
- **Scope**: `lib/routes.js` -> `lib/routes/auth.js`, `lib/routes/sessions.js`, `lib/routes/config.js`, `lib/routes/upload.js`
- **Plan**:
  - Split by concern: auth, sessions, config, upload, shortcuts, file-browser, port-proxy
  - Each module receives only its actual dependencies
  - `server.js` wires each with specific deps
- **Verify**: `npm test`
- [x] Done

### 3.2 Decompose handleUpgrade
- **Problem**: Auth + origin validation + proxy routing + session validation in one 80-line function (Hickey, Metz)
- **Scope**: `server.js` `handleUpgrade`
- **Plan**:
  - Extract `authenticateUpgrade(req)` -> `{authenticated, credentialId, sessionToken}`
  - Extract `validateUpgradeOrigin(req)` -> boolean
  - Extract `routeUpgrade(req)` -> `"terminal" | "port-proxy"`
  - Compose in `handleUpgrade`
- **Verify**: `npm test` + WebSocket integration tests
- [x] Done

### 3.3 Push migration logic into AuthState methods
- **Problem**: Repeated `new AuthState({...})` boilerplate — four migrations each manually rebuilding the whole object (Beck, Metz)
- **Scope**: `lib/auth-state.js`, `lib/auth.js` `migrateState`
- **Plan**:
  - Add `migrateCredentialMetadata()`, `cleanOrphanedSessions()`, `migrateSessionActivity()` to AuthState
  - Refactor `migrateState` into a clean pipeline
- **Verify**: `npm test`
- [x] Done

## Tier 4: Architectural Evolution (future — not this round)

Noted for future consideration. Each needs design discussion before implementation.

- **Explicit session state machine** (Lamport, Armstrong) — enum states (`CREATED`, `ATTACHED`, `DETACHED`, `KILLED`) with guarded transitions
- **Bidirectional transport bridge** (Kay) — session manager receives messages instead of direct method calls
- **Auth module decomposition** (Metz) — split persistence, migration, WebAuthn ceremonies into separate modules
- **P2P transport isolation** (Beck) — extract as transport decorator, remove from ws-manager core
- **Rename auth "sessions" to "loginSessions"** (Evans) — resolve the fatal "session" overload between auth tokens and terminal sessions
- **Auth state store extraction** (Hickey, FP) — separate the mutable cache + mutex from the pure AuthState value

## Review Consensus

| Finding | Agents | Count |
|---|---|---|
| `routeCtx` grab bag | Hickey, Kay, Metz, Beck | 4 |
| AuthState cache/mutex wrapping | Hickey, Kay, Evans, FP, Armstrong, Metz | 6 |
| Result type inconsistency | Kay, Evans, FP, Beck | 4 |
| Transport bridge underutilized | Kay, Evans, FP | 3 |
| routes.js god module | Metz, Beck | 2 |
| Shortcuts in SessionManager | Evans, Metz | 2 |
| handleUpgrade complecting | Hickey, Metz | 2 |
| Session state machine | Armstrong, Lamport | 2 |
| app.js 857-line script | Hickey, Metz | 2 |
