//! Device (credential) management routes.
//!
//! Registered credentials are the user-facing view of "devices"
//! paired with this instance. Two endpoints:
//!
//! - `GET    /api/credentials`      — auth required, list with
//!   per-device metadata
//! - `DELETE /api/credentials/:id`  — auth required (CSRF added in
//!   Phase 0a step 5); removes the credential AND its sessions;
//!   blocked for remote callers if it's the last credential on the
//!   instance
//!
//! The last-credential guard (Node scar `f25855f`) applies only to
//! remote callers. A localhost caller has physical access regardless
//! of whether any credentials exist — locking them out of their own
//! instance via "delete last passkey" would be a false safety.
//!
//! Revoking a credential cascades to its sessions via
//! `AuthState::remove_credential`. Active WebSocket connections
//! aren't torn down here — that's a WS-layer concern (Node scar
//! `c073ec7`).
//!
//! Wire shapes match Node `lib/routes/auth-routes.js:263-310`
//! byte-for-byte: list returns `{ credentials: [...] }` (NOT a bare
//! array) with camelCase fields; revoke returns `200 {"ok": true}`
//! (NOT 204). The earlier shape — bare array, snake_case — was the
//! pre-cutover Rust convention; Phase 0a step 3 reshapes it because
//! the JS frontend reads `data.credentials`, not `data` directly,
//! and parses `createdAt` not `created_at_millis`.

use crate::api::error::ApiError;
use crate::auth_middleware::{AuthContext, Authenticated};
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    routing::{delete, get},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::SystemTime;

pub fn device_routes() -> Router<AppState> {
    Router::new()
        .route("/api/credentials", get(list_devices))
        .route("/api/credentials/:id", delete(revoke_device))
}

/// Per-credential row on the device-management UI.
///
/// Field set is the Node intersection — `id`, `name`, `createdAt`,
/// `lastUsedAt`, `userAgent`, `setupTokenId`. Deliberately drops
/// `counter` and `is_current`: Node never exposed them and the
/// frontend doesn't read them. `counter` stays in `Credential` for
/// internal clone-detection bookkeeping; `is_current` was a Rust-only
/// addition that turned out to be redundant — the client already
/// knows its own credential id from `/api/me` (or from the post-login
/// response).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialEntry {
    id: String,
    /// Always emitted as a string. `Credential.name` is `Option<String>`
    /// internally; absent or empty maps to the empty string on the
    /// wire — Node uses `c.name` directly which JSON-serializes
    /// `undefined` as missing, but the frontend reads it with
    /// `c.name || ''` so empty-string is the safe canonical form.
    name: String,
    /// Unix-millis. `u64` for JSON safe-integer range.
    created_at: u64,
    /// Unix-millis of the last successful auth. `null` until the
    /// credential is used at least once.
    last_used_at: Option<u64>,
    /// User-Agent captured at register/pair time.
    user_agent: String,
    /// `Some` when this device was paired via a setup token. Mirrors
    /// `TokenEntry.credential` from the opposite side of the
    /// bidirectional link (Node scar `7742ac3`).
    setup_token_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ListResponse {
    credentials: Vec<CredentialEntry>,
}

async fn list_devices(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
) -> Result<Json<ListResponse>, ApiError> {
    let snap = state.auth_store.snapshot().await;
    let credentials: Vec<CredentialEntry> = snap
        .credentials
        .iter()
        .map(|c| CredentialEntry {
            id: c.id.clone(),
            name: c.name.clone().unwrap_or_default(),
            created_at: to_millis(c.created_at),
            last_used_at: c.last_used_at.map(to_millis),
            user_agent: c.user_agent.clone(),
            setup_token_id: c.setup_token_id.clone(),
        })
        .collect();
    Ok(Json(ListResponse { credentials }))
}

/// DELETE `/api/credentials/:id`.
///
/// Returns `200 {"ok": true}` on success, matching Node. The earlier
/// 204-no-content shape was a Rust convenience — switching to a JSON
/// body matches every other Node DELETE handler in this surface
/// (`/api/tokens/:id`, `/api/api-keys/:id`).
///
/// TODO: CSRF in Phase 0a step 5. The handler today is auth-only.
async fn revoke_device(
    State(state): State<AppState>,
    Authenticated(ctx): Authenticated,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let is_localhost = matches!(ctx, AuthContext::Localhost);
    let revoked_by = match &ctx {
        AuthContext::Localhost => "localhost".to_string(),
        AuthContext::Remote { credential, .. } => credential.id.clone(),
    };

    let credential_id = id.clone();
    // The closure decides three things atomically: (a) whether the
    // credential exists at all (404 outside if not), (b) whether the
    // remote-caller last-credential guard fires (`LastCredential` →
    // 403 with the literal Node message), (c) whether the cascade
    // emits a revocation broadcast (only when something actually
    // changed). Localhost callers bypass the last-credential check
    // entirely — physical access trumps the lockout concern.
    let existed = state
        .auth_store
        .transact(move |s| {
            let target_exists = s.find_credential(&id).is_some();
            if !target_exists {
                // Signal "not found" via Ok(false) so the closure stays
                // in the success path; the handler maps that to 404
                // outside. Using StateConflict here would route to 409
                // and lose the not-found semantic.
                return Ok((s.clone(), false));
            }
            if !is_localhost && s.credentials.len() == 1 {
                return Err(katulong_auth::AuthError::LastCredentialRemoval);
            }
            // `remove_credential` cascades to the credential's sessions.
            Ok((s.remove_credential(&id), true))
        })
        .await
        .map_err(ApiError::from)?;

    if !existed {
        return Err(ApiError::NotFound("Credential not found"));
    }
    state.revocations.emit(&credential_id);

    tracing::info!(
        credential_id = %credential_id,
        revoked_by = %revoked_by,
        "device revoked"
    );
    Ok(Json(json!({ "ok": true })))
}

fn to_millis(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
