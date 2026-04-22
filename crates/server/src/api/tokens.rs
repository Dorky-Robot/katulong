//! Setup-token management routes.
//!
//! Setup tokens are the remote-device pairing primitive. Admin flow:
//! the currently-authenticated user mints a token (carrying a short
//! name for audit) and hands the plaintext to the new device's
//! operator. The new device posts the plaintext to
//! `/api/auth/pair/start` + `/finish` (in `auth.rs`), which consumes
//! the token, registers a credential linked to the token, and mints
//! a session cookie.
//!
//! Three endpoints here:
//! - `GET    /api/auth/setup-tokens`       — list (auth)
//! - `POST   /api/auth/setup-tokens`       — create (auth + CSRF)
//! - `DELETE /api/auth/setup-tokens/:id`   — revoke (auth + CSRF)
//!
//! Revocation cascades to the paired device AND its sessions via
//! `AuthState::remove_setup_token` (Node scar `7742ac3`: bidirectional
//! link between tokens and credentials was added specifically so
//! "revoke this token" could also pull its device without a separate
//! API call).

use crate::api::csrf::CsrfProtected;
use crate::api::error::ApiError;
use crate::api::extract::JsonBody;
use crate::auth_middleware::Authenticated;
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use katulong_auth::{PlaintextToken, SetupToken};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};

/// Default setup-token lifetime. One hour is long enough for a user
/// to copy the plaintext, walk to the other device, and paste it in;
/// short enough that a lost token doesn't sit redeemable overnight.
/// Not currently overridable at the API level — operator tuning would
/// go through an env var or config file, not per-token.
const SETUP_TOKEN_TTL: Duration = Duration::from_secs(60 * 60);

pub fn token_routes() -> Router<AppState> {
    Router::new()
        // PROTECTED: list requires auth but not CSRF (GET is safe).
        .route("/api/auth/setup-tokens", get(list_tokens))
        // PROTECTED + CSRF: state-changing.
        .route("/api/auth/setup-tokens", post(create_token))
        .route("/api/auth/setup-tokens/:id", delete(revoke_token))
}

#[derive(Debug, Serialize)]
struct TokenListEntry {
    id: String,
    name: Option<String>,
    /// Unix millis. Clients compute "expires in" locally.
    /// Unix-millis encoded as `u64`. `u128` would overflow
    /// `serde_json`'s 2^53 safe-integer range into a string, which
    /// JS clients parsing `v.as_u64()` would then drop. u64 holds
    /// unix-ms out to year 584,554,051 — ample.
    expires_at_millis: u64,
    /// Stable semantic tag:
    /// - `"live"` — not used, not expired, redeemable by a new device
    /// - `"used"` — already consumed; linked credential still paired
    /// - `"expired"` — past TTL, never used
    status: &'static str,
    /// When `status == "used"`, the id of the device this token
    /// created. Populated from the bidirectional link set in
    /// `AuthState::consume_setup_token` (Node scar `7742ac3`).
    credential_id: Option<String>,
}

/// List setup tokens. Auth-only (no CSRF) because GET is a safe
/// method — no state change to protect against cross-site replay.
/// Write-path handlers in this module use `CsrfProtected`; the
/// distinction is intentional and consistent with axum/HTTP norms.
async fn list_tokens(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
) -> Result<Json<Vec<TokenListEntry>>, ApiError> {
    let now = SystemTime::now();
    let snap = state.auth_store.snapshot().await;
    let entries: Vec<TokenListEntry> = snap
        .setup_tokens
        .iter()
        .map(|t| TokenListEntry {
            id: t.id.clone(),
            name: t.name.clone(),
            expires_at_millis: t
                .expires_at
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            status: if t.is_consumed() {
                "used"
            } else if t.is_expired(now) {
                "expired"
            } else {
                "live"
            },
            credential_id: t.credential_id.clone(),
        })
        .collect();
    Ok(Json(entries))
}

#[derive(Debug, Deserialize)]
struct CreateTokenRequest {
    /// Optional human-readable tag, shown in the device-management
    /// UI. Clipped server-side to avoid unbounded storage from a
    /// malicious caller (who, to be clear, is already authenticated —
    /// this is defence in depth, not a boundary control).
    name: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateTokenResponse {
    id: String,
    /// Hand this to the user. Once the HTTP response is sent, the
    /// server holds only the scrypt hash — recovery is impossible.
    plaintext: PlaintextToken,
    /// Unix-millis encoded as `u64`. `u128` would overflow
    /// `serde_json`'s 2^53 safe-integer range into a string, which
    /// JS clients parsing `v.as_u64()` would then drop. u64 holds
    /// unix-ms out to year 584,554,051 — ample.
    expires_at_millis: u64,
}

/// Max length for the human-readable `name` field. Chosen so a
/// label comfortably holds a device nickname ("Felix iPad") without
/// giving an authenticated caller a vector to grow the state file.
const TOKEN_NAME_MAX_LEN: usize = 64;

async fn create_token(
    State(state): State<AppState>,
    CsrfProtected(_): CsrfProtected,
    JsonBody(body): JsonBody<CreateTokenRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let name = body
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    if let Some(ref n) = name {
        if n.chars().count() > TOKEN_NAME_MAX_LEN {
            return Err(ApiError::BadRequest("name exceeds 64 characters"));
        }
    }
    let now = SystemTime::now();
    let (plaintext, token) =
        SetupToken::issue(name, now, SETUP_TOKEN_TTL).map_err(ApiError::from)?;
    let id = token.id.clone();
    let expires_at = token.expires_at;
    state
        .auth_store
        .transact(|s| Ok((s.add_setup_token(token.clone()), ())))
        .await
        .map_err(ApiError::from)?;

    tracing::info!(token_id = %id, "setup token minted");
    Ok((
        StatusCode::CREATED,
        Json(CreateTokenResponse {
            id,
            plaintext,
            expires_at_millis: expires_at
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }),
    ))
}

async fn revoke_token(
    State(state): State<AppState>,
    CsrfProtected(_): CsrfProtected,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // `remove_setup_token` is a no-op on unknown ids — we treat that
    // as idempotent success (204). The caller can't tell "never
    // existed" from "already revoked," which is fine: both answers
    // mean "this id is not redeemable from here forward."
    //
    // Revoking a token cascades (via `AuthState::remove_setup_token`)
    // to removing the credential it paired and that credential's
    // sessions. Any transport currently holding a connection bound
    // to that credential needs the revocation broadcast, same as
    // direct device-revoke. We read the paired credential id BEFORE
    // the transact closure runs so we know what to emit afterwards.
    let token_id = id.clone();
    let paired_credential_id = state
        .auth_store
        .transact(move |s| {
            let paired = s
                .find_setup_token(&id)
                .and_then(|t| t.credential_id.clone());
            Ok((s.remove_setup_token(&id), paired))
        })
        .await
        .map_err(ApiError::from)?;

    if let Some(ref cred_id) = paired_credential_id {
        state.revocations.emit(cred_id);
    }

    tracing::info!(
        token_id = %token_id,
        paired_credential_id = paired_credential_id.as_deref().unwrap_or("none"),
        "setup token revoked"
    );
    Ok(StatusCode::NO_CONTENT)
}
