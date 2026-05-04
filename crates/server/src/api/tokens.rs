//! Setup-token management routes.
//!
//! Setup tokens are the remote-device pairing primitive. Admin flow:
//! the currently-authenticated user mints a token (carrying a short
//! name for audit) and hands the plaintext to the new device's
//! operator. The new device posts the plaintext to
//! `/auth/pair/options` + `/finish` (in `auth.rs`), which consumes
//! the token, registers a credential linked to the token, and mints
//! a session cookie.
//!
//! Four endpoints:
//! - `GET    /api/tokens`       — list (auth)
//! - `POST   /api/tokens`       — create (auth)
//! - `DELETE /api/tokens/:id`   — revoke (auth)
//! - `PATCH  /api/tokens/:id`   — rename (auth)
//!
//! TODO: CSRF on the three state-mutating handlers in Phase 0a step 5.
//! The handlers stay auth-only for this commit so the wire reshape
//! lands in isolation.
//!
//! Wire shapes match Node `lib/routes/auth-routes.js:347-476`
//! byte-for-byte: list returns `{ tokens: [...] }` with each entry
//! carrying a nested `credential` object (or null) — the cross-cut
//! between setup tokens and the credentials they paired. Create
//! returns 200 (NOT 201) with `{id, name, token, createdAt,
//! expiresAt}` — the plaintext field is named `token`, not
//! `plaintext`. Revoke + PATCH both return `200 {"ok": true}`.

use crate::api::error::ApiError;
use crate::api::extract::JsonBody;
use crate::auth_middleware::Authenticated;
use crate::state::AppState;
use axum::{
    extract::{Path, State},
    routing::{delete, get, patch, post},
    Json, Router,
};
use katulong_auth::{Credential, SetupToken};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime};

/// Default setup-token lifetime. One hour is long enough for a user
/// to copy the plaintext, walk to the other device, and paste it in;
/// short enough that a lost token doesn't sit redeemable overnight.
const SETUP_TOKEN_TTL: Duration = Duration::from_secs(60 * 60);

/// Max length for the human-readable `name` field. Node enforces 128;
/// match it so the same client-side validation message lands.
const TOKEN_NAME_MAX_LEN: usize = 128;

pub fn token_routes() -> Router<AppState> {
    Router::new()
        .route("/api/tokens", get(list_tokens))
        .route("/api/tokens", post(create_token))
        .route("/api/tokens/:id", delete(revoke_token))
        .route("/api/tokens/:id", patch(rename_token))
}

// ---------------- list ----------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEntry {
    id: String,
    name: String,
    created_at: u64,
    last_used_at: Option<u64>,
    /// `null` when the token has no expiry. Tokens minted via this
    /// crate always carry one, but the field stays nullable to mirror
    /// Node's union type and remain forward-compatible with a future
    /// "perma-token" mode.
    expires_at: Option<u64>,
    /// Nested credential row when this token has been redeemed and
    /// the paired credential still exists. `None` when the token is
    /// live (not yet used) OR when it was used and the resulting
    /// credential was later revoked. Mirrors Node's
    /// `tokenData.credential = null` default + conditional fill.
    credential: Option<NestedCredential>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NestedCredential {
    id: String,
    name: String,
    created_at: u64,
    last_used_at: Option<u64>,
    user_agent: String,
}

#[derive(Debug, Serialize)]
struct ListResponse {
    tokens: Vec<TokenEntry>,
}

async fn list_tokens(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
) -> Result<Json<ListResponse>, ApiError> {
    let snap = state.auth_store.snapshot().await;
    let tokens: Vec<TokenEntry> = snap
        .setup_tokens
        .iter()
        .map(|t| {
            // Resolve the paired credential, if any, by walking the
            // snapshot's credential list. Read-time only — no
            // persistence change here. The `credentialId` field on
            // the setup token is the authoritative pointer; if a
            // post-pair credential revoke removed the row, the
            // lookup returns `None` and the wire shows `credential:
            // null`, which Node's frontend already handles ("token
            // used, device revoked" path).
            let credential = t.credential_id.as_deref().and_then(|cid| {
                snap.credentials
                    .iter()
                    .find(|c| c.id == cid)
                    .map(nested_credential)
            });
            TokenEntry {
                id: t.id.clone(),
                name: t.name.clone().unwrap_or_default(),
                created_at: to_millis(t.created_at),
                last_used_at: t.used_at.map(to_millis),
                expires_at: Some(to_millis(t.expires_at)),
                credential,
            }
        })
        .collect();
    Ok(Json(ListResponse { tokens }))
}

fn nested_credential(c: &Credential) -> NestedCredential {
    NestedCredential {
        id: c.id.clone(),
        name: c.name.clone().unwrap_or_default(),
        created_at: to_millis(c.created_at),
        last_used_at: c.last_used_at.map(to_millis),
        user_agent: c.user_agent.clone(),
    }
}

// ---------------- create ----------------

#[derive(Debug, Deserialize)]
struct CreateTokenRequest {
    /// Required, non-empty after trim, ≤ 128 chars. Node treats name
    /// as mandatory on this route (the device-management UI prompts
    /// for it before submitting); match that contract so a frontend
    /// mistake surfaces as 400 here rather than getting silently
    /// stored as an empty label.
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateTokenResponse {
    id: String,
    name: String,
    /// Plaintext token. Once the HTTP response is sent, the server
    /// holds only the scrypt hash — recovery is impossible. Field is
    /// named `token` (NOT `plaintext`) to match Node's wire shape;
    /// the frontend reads `data.token`.
    token: String,
    created_at: u64,
    expires_at: u64,
}

/// POST `/api/tokens` returns 200, NOT 201. Node uses 200 for create
/// here; the previous Rust 201 was a REST-purist convenience.
/// Matching Node means the JS frontend's `if (resp.ok)` keeps
/// working unchanged.
///
/// TODO: CSRF in Phase 0a step 5.
async fn create_token(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
    JsonBody(body): JsonBody<CreateTokenRequest>,
) -> Result<Json<CreateTokenResponse>, ApiError> {
    let trimmed = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(ApiError::BadRequest("Token name is required"))?;
    if trimmed.chars().count() > TOKEN_NAME_MAX_LEN {
        return Err(ApiError::BadRequest(
            "Token name too long (max 128 characters)",
        ));
    }

    let now = SystemTime::now();
    let (plaintext, token) =
        SetupToken::issue(Some(trimmed.clone()), now, SETUP_TOKEN_TTL).map_err(ApiError::from)?;
    let id = token.id.clone();
    let expires_at = token.expires_at;
    let created_at = token.created_at;
    state
        .auth_store
        .transact(|s| Ok((s.add_setup_token(token.clone()), ())))
        .await
        .map_err(ApiError::from)?;

    tracing::info!(token_id = %id, "setup token minted");
    Ok(Json(CreateTokenResponse {
        id,
        name: trimmed,
        token: plaintext.into(),
        created_at: to_millis(created_at),
        expires_at: to_millis(expires_at),
    }))
}

// ---------------- revoke ----------------

/// DELETE `/api/tokens/:id` — returns `200 {"ok": true}`. Cascades to
/// the paired credential (if any) and emits the revocation broadcast.
/// Idempotent on unknown ids: returns 404 instead of 200 — Node
/// distinguishes "never existed" with a 404 here (unlike the
/// credential delete path, which it ALSO 404s).
///
/// TODO: CSRF in Phase 0a step 5.
async fn revoke_token(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let token_id = id.clone();
    // Resolve "did the token exist" + "what credential did it pair"
    // inside the closure so a concurrent revoke can't race past the
    // pre-flight. The handler emits the broadcast outside the mutex
    // — tokio::broadcast is intentionally unblocking so we never
    // hold the auth-state mutex across an await on a slow receiver.
    let outcome = state
        .auth_store
        .transact(move |s| {
            let Some(t) = s.find_setup_token(&id) else {
                return Ok((s.clone(), TokenRevokeOutcome::NotFound));
            };
            let paired = t.credential_id.clone();
            Ok((s.remove_setup_token(&id), TokenRevokeOutcome::Removed(paired)))
        })
        .await
        .map_err(ApiError::from)?;

    match outcome {
        TokenRevokeOutcome::NotFound => Err(ApiError::NotFound("Token not found")),
        TokenRevokeOutcome::Removed(paired) => {
            if let Some(cred_id) = paired {
                state.revocations.emit(&cred_id);
                tracing::info!(
                    token_id = %token_id,
                    credential_id = %cred_id,
                    "setup token revoked; paired credential removed"
                );
            } else {
                tracing::info!(
                    token_id = %token_id,
                    "setup token revoked (no paired credential)"
                );
            }
            Ok(Json(json!({ "ok": true })))
        }
    }
}

enum TokenRevokeOutcome {
    NotFound,
    Removed(Option<String>),
}

// ---------------- rename (PATCH) ----------------

#[derive(Debug, Deserialize)]
struct PatchTokenRequest {
    name: Option<String>,
}

/// PATCH `/api/tokens/:id` — rename. Returns `200 {"ok": true}` on
/// success, `404` on unknown id, `400` on missing/empty/oversized name.
/// Mirrors Node `auth-routes.js:452-476` exactly.
///
/// TODO: CSRF in Phase 0a step 5.
async fn rename_token(
    State(state): State<AppState>,
    Authenticated(_): Authenticated,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<PatchTokenRequest>,
) -> Result<Json<Value>, ApiError> {
    let trimmed = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(ApiError::BadRequest("Token name is required"))?;
    if trimmed.chars().count() > TOKEN_NAME_MAX_LEN {
        return Err(ApiError::BadRequest(
            "Token name too long (max 128 characters)",
        ));
    }

    let token_id = id.clone();
    let new_name = trimmed.clone();
    let existed = state
        .auth_store
        .transact(move |s| {
            if s.find_setup_token(&id).is_none() {
                return Ok((s.clone(), false));
            }
            Ok((s.update_setup_token_name(&id, new_name.clone()), true))
        })
        .await
        .map_err(ApiError::from)?;

    if !existed {
        return Err(ApiError::NotFound("Token not found"));
    }
    tracing::info!(token_id = %token_id, name = %trimmed, "setup token renamed");
    Ok(Json(json!({ "ok": true })))
}

// ---------------- helpers ----------------

fn to_millis(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
