//! Authentication HTTP routes.
//!
//! Five endpoints covering the first-device happy path:
//!
//! - `GET  /api/auth/status`          — public; surfaces access mode + install state
//! - `POST /api/auth/register/start`  — localhost-only, no existing credentials
//! - `POST /api/auth/register/finish` — localhost-only, no existing credentials
//! - `POST /api/auth/login/start`     — public
//! - `POST /api/auth/login/finish`    — public; mints session on success
//!
//! Logout + setup-token pairing (for adding a second device over a
//! tunnel) land in slice 6.
//!
//! Every successful ceremony writes through `AuthStore::transact` so
//! the "compute new state, persist atomically, swap in memory" contract
//! holds. Snapshots are taken exactly once per handler; callers read
//! from the snapshot and the subsequent `transact` closure re-reads
//! the (possibly newer) state inside the mutex — cheaper than a
//! double round-trip and correct under contention.

use crate::access::AccessMethod;
use crate::api::error::ApiError;
use crate::cookie::build_set_cookie;
use crate::state::AppState;
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use katulong_auth::webauthn_wire::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse,
};
use katulong_auth::{ChallengeId, Session, SESSION_TTL};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::SystemTime;
use uuid::Uuid;

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        // PUBLIC: reports whether the instance has any credentials and
        // which access mode this request is coming from; the client
        // uses this to pick between register/login UI.
        .route("/api/auth/status", get(status))
        // PUBLIC (but state-gated): first-device registration. Only
        // works from localhost AND only when no credentials exist.
        // Additional-device registration uses the setup-token flow in
        // slice 6, not this route.
        .route("/api/auth/register/start", post(register_start))
        .route("/api/auth/register/finish", post(register_finish))
        // PUBLIC: anyone can try to log in. The ceremony itself gates
        // who actually succeeds.
        .route("/api/auth/login/start", post(login_start))
        .route("/api/auth/login/finish", post(login_finish))
}

#[derive(Debug, Serialize)]
struct AuthStatus {
    /// `"localhost"` or `"remote"` — the binary access model. No LAN
    /// tier; see project memory `project_access_model_no_lan`.
    access_method: &'static str,
    /// True when at least one credential is registered. A fresh
    /// install reports `false` and the client routes to the register
    /// flow.
    has_credentials: bool,
    /// True when the current request would pass the `Authenticated`
    /// extractor — localhost peers are always authenticated; remote
    /// peers need a valid cookie.
    authenticated: bool,
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<AuthStatus> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    let snap = state.auth_store.snapshot().await;
    let has_credentials = !snap.credentials.is_empty();

    // Reuse the same cookie-lookup path as the extractor so the
    // "authenticated" field can't drift from the middleware's answer.
    let authenticated = match access {
        AccessMethod::Localhost => true,
        AccessMethod::Remote => headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(crate::cookie::extract_session_token)
            .and_then(|token| snap.valid_session(&token, SystemTime::now()).cloned())
            .is_some(),
    };

    Json(AuthStatus {
        access_method: match access {
            AccessMethod::Localhost => "localhost",
            AccessMethod::Remote => "remote",
        },
        has_credentials,
        authenticated,
    })
}

#[derive(Debug, Serialize)]
struct ChallengeStart<T: Serialize> {
    challenge_id: ChallengeId,
    options: T,
}

#[derive(Debug, Deserialize)]
struct FinishRegister {
    challenge_id: ChallengeId,
    response: RegisterPublicKeyCredential,
}

#[derive(Debug, Deserialize)]
struct FinishLogin {
    challenge_id: ChallengeId,
    response: PublicKeyCredential,
}

/// Start a first-device registration ceremony.
///
/// First-device is the ONLY registration path this slice supports.
/// Adding subsequent devices goes through the setup-token flow in
/// slice 6 (which reuses `WebAuthnService::start_registration` but
/// gates the state differently).
///
/// Two guards:
/// 1. `access == Localhost` — physical access is required to bootstrap
///    the first device, since there's nothing to authenticate against
///    yet. If we let this run from a tunnel, anyone with the URL could
///    register their own key on a fresh install.
/// 2. `credentials.is_empty()` — once any device is registered, further
///    registrations must go through pairing so the existing user can
///    authorise them.
async fn register_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<ChallengeStart<CreationChallengeResponse>>, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    guard_first_device_registration(&state, AccessMethod::classify(peer, host)).await?;

    let snap = state.auth_store.snapshot().await;
    let (id, ccr) = state
        .webauthn
        .start_registration(
            Uuid::new_v4(),
            "katulong",
            "Katulong",
            &snap.credentials,
            SystemTime::now(),
        )
        .map_err(ApiError::from)?;
    Ok(Json(ChallengeStart {
        challenge_id: id,
        options: ccr,
    }))
}

/// Finish the first-device registration, persist the credential, and
/// mint a session cookie bound to it.
async fn register_finish(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<FinishRegister>,
) -> Result<impl IntoResponse, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    guard_first_device_registration(&state, AccessMethod::classify(peer, host)).await?;

    let now = SystemTime::now();
    let credential = state
        .webauthn
        .finish_registration(&body.challenge_id, &body.response, now)
        .map_err(ApiError::from)?;

    // Persist credential + mint session atomically so a crash between
    // the two writes can't leave a registered credential with no way to
    // log in. `transact` holds the mutex across the closure.
    let session = state
        .auth_store
        .transact(|s| {
            let session = Session::mint(credential.id.clone(), now, SESSION_TTL);
            let next = s
                .upsert_credential(credential.clone())
                .upsert_session(session.clone());
            Ok((next, session))
        })
        .await
        .map_err(ApiError::from)?;

    Ok(session_cookie_response(
        StatusCode::CREATED,
        &session.token,
        state.config.cookie_secure,
        Json(RegisterFinishBody {
            credential_id: credential.id,
            csrf_token: session.csrf_token,
        }),
    ))
}

#[derive(Debug, Serialize)]
struct RegisterFinishBody {
    credential_id: String,
    csrf_token: String,
}

/// Start an authentication ceremony. Public — the ceremony itself
/// gates who actually passes.
async fn login_start(
    State(state): State<AppState>,
) -> Result<Json<ChallengeStart<RequestChallengeResponse>>, ApiError> {
    let snap = state.auth_store.snapshot().await;
    if snap.credentials.is_empty() {
        // Fresh-install case. Return an explicit conflict rather than
        // letting webauthn-rs surface "no usable credentials" as a 401;
        // the client should route to the register flow instead.
        return Err(ApiError::Conflict(
            "no credentials registered; first device must register via /api/auth/register/start",
        ));
    }
    let (id, rcr) = state
        .webauthn
        .start_authentication(&snap.credentials, SystemTime::now())
        .map_err(ApiError::from)?;
    Ok(Json(ChallengeStart {
        challenge_id: id,
        options: rcr,
    }))
}

/// Finish an authentication ceremony, persist the counter update, and
/// mint a session cookie.
async fn login_finish(
    State(state): State<AppState>,
    Json(body): Json<FinishLogin>,
) -> Result<impl IntoResponse, ApiError> {
    let now = SystemTime::now();
    let snap = state.auth_store.snapshot().await;
    let verified = state
        .webauthn
        .finish_authentication(&body.challenge_id, &body.response, &snap.credentials, now)
        .map_err(ApiError::from)?;

    // `updated_credential` is `Some` iff the authenticator reported a
    // counter or backup-state change. Persisting it advances the
    // monotonicity baseline inside the stored Passkey blob — see
    // `VerifiedAuthentication` docs for why this MUST happen.
    let credential_id = verified.credential_id.clone();
    let session = state
        .auth_store
        .transact(move |s| {
            let session = Session::mint(credential_id.clone(), now, SESSION_TTL);
            let mut next = s.clone();
            if let Some(updated) = verified.updated_credential.clone() {
                next = next.upsert_credential(updated);
            }
            next = next.upsert_session(session.clone());
            Ok((next, session))
        })
        .await
        .map_err(ApiError::from)?;

    Ok(session_cookie_response(
        StatusCode::OK,
        &session.token,
        state.config.cookie_secure,
        Json(LoginFinishBody {
            credential_id: verified.credential_id,
            csrf_token: session.csrf_token,
        }),
    ))
}

#[derive(Debug, Serialize)]
struct LoginFinishBody {
    credential_id: String,
    csrf_token: String,
}

/// Guard both first-device registration endpoints.
///
/// Must be localhost AND must have zero existing credentials.
/// Returning `Forbidden` (not `Unauthorized`) because the caller is
/// authenticated-ish via locality; the action is just not permitted in
/// the current server state. `Conflict` for "already initialised" to
/// distinguish from "wrong place."
async fn guard_first_device_registration(
    state: &AppState,
    access: AccessMethod,
) -> Result<(), ApiError> {
    if !matches!(access, AccessMethod::Localhost) {
        return Err(ApiError::Forbidden(
            "first-device registration must originate from localhost",
        ));
    }
    let snap = state.auth_store.snapshot().await;
    if !snap.credentials.is_empty() {
        return Err(ApiError::Conflict(
            "instance already initialised; additional devices must pair via setup token",
        ));
    }
    Ok(())
}

/// Build a response that attaches a Set-Cookie header carrying a fresh
/// session, alongside the handler's JSON body.
fn session_cookie_response<B>(
    status: StatusCode,
    token: &str,
    secure: bool,
    body: B,
) -> impl IntoResponse
where
    B: IntoResponse,
{
    let cookie = build_set_cookie(token, SESSION_TTL.as_secs(), secure);
    (status, [(header::SET_COOKIE, cookie)], body)
}

