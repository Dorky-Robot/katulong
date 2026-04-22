//! Device (credential) management routes.
//!
//! Registered credentials are the user-facing view of "devices"
//! paired with this instance. Two endpoints:
//!
//! - `GET    /api/auth/devices`      — auth required, list with
//!   per-device metadata
//! - `DELETE /api/auth/devices/:id`  — auth + CSRF required; removes
//!   the credential AND its sessions; blocked for remote callers if
//!   it's the last credential on the instance
//!
//! The last-credential guard (Node scar `f25855f`) applies only to
//! remote callers. A localhost caller has physical access regardless
//! of whether any credentials exist — locking them out of their own
//! instance via "delete last passkey" would be a false safety.
//!
//! Revoking a credential cascades to its sessions via
//! `AuthState::remove_credential`. Active WebSocket connections
//! aren't torn down here — that's a WS-layer concern (Node scar
//! `c073ec7`), and WS isn't in the Rust port yet. When it lands, the
//! WS upgrade path should revalidate the session on every message
//! and close on missing-credential.

use crate::api::csrf::CsrfProtected;
use crate::api::error::ApiError;
use crate::auth_middleware::{AuthContext, Authenticated};
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get},
    Json, Router,
};
use serde::Serialize;
use std::time::SystemTime;

pub fn device_routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/devices", get(list_devices))
        .route("/api/auth/devices/:id", delete(revoke_device))
}

#[derive(Debug, Serialize)]
struct DeviceEntry {
    id: String,
    name: Option<String>,
    /// Unix-millis of registration. `u64` for JSON integer safety —
    /// `u128` would serialize as a string past 2^53.
    created_at_millis: u64,
    /// Last counter observed from the authenticator. Zero is normal
    /// for counterless synced passkeys.
    counter: u32,
    /// `Some` when this device was paired via a setup token. Mirrors
    /// `TokenListEntry.credential_id` from the opposite side of the
    /// bidirectional link (Node scar `7742ac3`). Name matches the
    /// `Credential.setup_token_id` field directly.
    setup_token_id: Option<String>,
    /// True when this entry is the credential the caller is
    /// currently authenticated as. `Localhost` callers have no
    /// current credential; all entries report `false`. Server-side
    /// resolution (Node scar `c44bef3`): identity flows authority →
    /// client, never inferred by localStorage or similar heuristics.
    is_current: bool,
}

async fn list_devices(
    State(state): State<AppState>,
    Authenticated(ctx): Authenticated,
) -> Result<Json<Vec<DeviceEntry>>, ApiError> {
    let current_id = match &ctx {
        AuthContext::Remote { credential, .. } => Some(credential.id.clone()),
        AuthContext::Localhost => None,
    };
    let snap = state.auth_store.snapshot().await;
    let entries: Vec<DeviceEntry> = snap
        .credentials
        .iter()
        .map(|c| DeviceEntry {
            id: c.id.clone(),
            name: c.name.clone(),
            created_at_millis: c
                .created_at
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            counter: c.counter,
            setup_token_id: c.setup_token_id.clone(),
            is_current: current_id.as_deref() == Some(c.id.as_str()),
        })
        .collect();
    Ok(Json(entries))
}

async fn revoke_device(
    State(state): State<AppState>,
    CsrfProtected(ctx): CsrfProtected,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let is_localhost = matches!(ctx, AuthContext::Localhost);
    let revoked_by = match &ctx {
        AuthContext::Localhost => "localhost".to_string(),
        AuthContext::Remote { credential, .. } => credential.id.clone(),
    };

    // The last-credential check runs inside `transact` so a
    // concurrent registration (or revocation) cannot slip past on a
    // stale snapshot. Remote callers fail with `LastCredentialRemoval`
    // → 409 `last_credential` if the state would hit zero
    // credentials; localhost callers bypass the check entirely
    // (physical access = no lockout risk). `LastCredentialRemoval`
    // is a dedicated `AuthError` variant so the HTTP layer's mapping
    // is compiler-enforced rather than string-matched.
    let credential_id = id.clone();
    // `transact` returns whether the credential actually existed —
    // used below to decide whether to emit the revocation broadcast.
    // Unknown id → no state change → no signal (no one has a
    // live connection bound to an id that never existed).
    let existed = state
        .auth_store
        .transact(move |s| {
            let target_exists = s.find_credential(&id).is_some();
            if !is_localhost && target_exists && s.credentials.len() == 1 {
                return Err(katulong_auth::AuthError::LastCredentialRemoval);
            }
            // `remove_credential` cascades to the credential's
            // sessions (slice 1+2 transition). Unknown id is a no-op
            // — idempotent DELETE.
            Ok((s.remove_credential(&id), target_exists))
        })
        .await
        .map_err(ApiError::from)?;

    if existed {
        state.revocations.emit(&credential_id);
    }

    tracing::info!(
        credential_id = %credential_id,
        revoked_by = %revoked_by,
        "device revoked"
    );
    Ok(StatusCode::NO_CONTENT)
}
