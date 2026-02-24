# Authentication Simplification Proposal

## Current Problems

1. **Mixed credential types**: WebAuthn credentials vs "paired" credentials with `publicKey: null`
2. **Over-engineered setup tokens**: Full CRUD API for what should be a simple bootstrap mechanism
3. **Unclear lifecycle**: When should setup tokens be used? When should they be removed?
4. **Conceptual confusion**: `isSetup()` checks credentials, but setup tokens exist in auth state

## Simplified Mental Model

### Core Concepts

1. **Credentials** = WebAuthn passkeys only (cryptographic proof of identity)
2. **Sessions** = Temporary authentication tokens (created by credentials or pairing)
3. **Setup Tokens** = Bootstrap secrets for first credential registration
4. **Pairing Codes** = Short-lived codes for adding devices (authorized by existing session)

### Authentication States

```
┌─────────────────┐
│   Not Setup     │ ← No credentials exist
│  (first boot)   │
└────────┬────────┘
         │ use setup token
         │ register passkey
         ▼
┌─────────────────┐
│   Setup         │ ← Credentials exist
│ (operational)   │
└─────────────────┘
```

### Authentication Flows

**First Device (LAN or Remote):**
```
1. User provides setup token (env var or created via CLI)
2. System validates token
3. User registers WebAuthn passkey
4. Token consumed/marked as used
5. Credential created → isSetup() = true
```

**Additional Devices (LAN - QR Code):**
```
1. Authenticated user creates pairing code (6-digit PIN)
2. New device scans QR code
3. New device enters PIN
4. System creates session (no credential)
5. User registers WebAuthn passkey (optional but encouraged)
```

**Additional Devices (Remote - API Token):**
```
1. Authenticated user creates setup token via UI
2. User copies token to new device
3. New device uses token to register passkey
4. Token consumed/marked as used
5. Credential created
```

## Proposed Changes

### 1. Separate Setup Tokens from AuthState

**Problem**: Setup tokens are stored alongside credentials and sessions in the auth state. This conflates bootstrap state with operational state.

**Solution**: Store setup tokens separately (e.g., `katulong-setup-tokens.json` or database table if using one).

**Rationale**:
- Setup tokens are for bootstrapping, not operational auth
- They should be manageable even when auth system is broken
- They have different lifecycle (created by admin, consumed by registration)

### 2. Remove "Paired" Credentials

**Problem**: Pairing creates fake credentials with `publicKey: null` and `type: 'paired'`. This pollutes the credential model.

**Solution**: Pairing creates sessions only. To make a paired device permanent, prompt user to register a passkey.

**Rationale**:
- A credential should always be a cryptographic proof
- Sessions are already the right abstraction for temporary access
- This matches how pairing actually works (you're not proving identity, you're being vouched for)

### 3. Simplify Setup Token API

**Problem**: Full CRUD API (`POST/GET/DELETE/PATCH /api/tokens`) is over-engineered for the use case.

**Solution**: Two operations only:
- `POST /api/tokens` - Create new setup token (returns token value once)
- `GET /api/tokens` - List existing tokens (metadata only, not values)
- `DELETE /api/tokens/:id` - Revoke token

Remove: PATCH (renaming is not critical), lastUsedAt tracking (doesn't add value)

### 4. Clarify Setup Token Lifecycle

**Options:**

**Option A: One-time tokens (GitHub style)**
- Token consumed on first use
- Automatically removed after use
- User creates new token for each device

**Option B: Reusable tokens (API key style)**
- Token can be used multiple times
- User manually revokes when done
- Track lastUsedAt for security audit

**Recommendation**: Option A (one-time) for simplicity and security. If user needs to add multiple devices, they can create multiple tokens.

### 5. Fix isSetup() Semantics

**Current**: Checks if credentials exist
**Problem**: State file might exist with tokens but no credentials

**Solution**: Keep current implementation, but make it explicit:
```javascript
export function isSetup() {
  const state = loadState();
  // Setup = at least one credential (passkey) exists
  // Setup tokens alone don't mean "setup"
  return state !== null && state.credentials.length > 0;
}
```

## Implementation Plan

### Phase 1: Clarify Concepts (No Breaking Changes)

1. Add comments explaining credential types
2. Mark "paired" credentials as deprecated in code comments
3. Document the intended flow in CLAUDE.md

### Phase 2: Remove Paired Credentials

1. Change pairing flow to create sessions only (no credential)
2. After pairing succeeds, prompt user to register passkey for permanent access
3. Add migration to convert existing paired credentials to... what?
   - Option A: Delete them (force re-authentication)
   - Option B: Keep them but mark as legacy
   - Option C: Convert to long-lived sessions with explicit expiry

### Phase 3: Separate Setup Tokens (Breaking Change)

1. Create new file: `katulong-setup-tokens.json`
2. Move setup token management out of AuthState
3. Create new module: `lib/setup-tokens.js`
4. Add migration to move tokens from auth.json to setup-tokens.json

### Phase 4: Simplify API

1. Remove PATCH /api/tokens (rename operation)
2. Remove lastUsedAt tracking
3. Make tokens one-time use by default
4. Remove tokens from auth state after consumption

## Questions to Answer

1. **What should happen to existing paired credentials?**
   - Delete them (requires re-pairing)?
   - Keep them as legacy?
   - Convert to long sessions?

2. **Should setup tokens be reusable or one-time?**
   - One-time = simpler, more secure
   - Reusable = more convenient for bulk device provisioning

3. **Where should setup tokens be stored?**
   - Separate file?
   - Same file but different namespace?
   - In-memory only (stateless)?

4. **Should we support both LAN (QR) and Remote (token) pairing?**
   - Current: Yes, split at pairing creation time
   - Alternative: Unify them (QR code encodes a token)

## Recommendation

**Start small:**

1. Fix the immediate bug (isSetup() is already correct, just add tests)
2. Add clear documentation about credential types
3. Don't add more features to setup tokens
4. Consider whether "permanent pairing" (paired credentials) is actually needed

**Then decide:**

Do we actually need persistent setup tokens at all? Or can we simplify to:
- Single `SETUP_TOKEN` env var for first device (initial bootstrap)
- Pairing codes (QR + PIN) for LAN devices (temporary, in-memory)
- Optional: API tokens for remote devices (one-time, ephemeral)

The current implementation feels like it's solving problems that don't exist yet.
