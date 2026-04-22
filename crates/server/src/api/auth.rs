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
//! the "compute new state, persist atomically, swap in memory"
//! contract holds. Invariants that gate a write (e.g., "first device
//! only") are checked **inside** the transact closure so the mutex
//! is the authoritative enforcement point — a pre-flight guard stays
//! as a fast-fail for the common non-racing case.

use crate::access::AccessMethod;
use crate::api::error::ApiError;
use crate::auth_middleware::Authenticated;
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
use katulong_auth::{fresh_user_handle, AuthError, ChallengeId, Session, SESSION_TTL};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::SystemTime;

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

/// JSON wire format for the status endpoint.
///
/// Snake_case on purpose — this is a fresh Rust-only wire format, no
/// migrated Node clients to stay compatible with. Serde's default
/// encoding already uses the struct field names so we don't carry a
/// `rename_all` attribute. Any future interop requirement would land
/// as an explicit rename.
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
    /// extractor. Derived from the same extractor in-process (via
    /// `Option<Authenticated>`) so the two can't drift — if the
    /// extractor's acceptance criteria change later, `status` tracks
    /// automatically.
    authenticated: bool,
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    authed: Option<Authenticated>,
) -> Json<AuthStatus> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    let snap = state.auth_store.snapshot().await;
    Json(AuthStatus {
        access_method: match access {
            AccessMethod::Localhost => "localhost",
            AccessMethod::Remote => "remote",
        },
        has_credentials: !snap.credentials.is_empty(),
        authenticated: authed.is_some(),
    })
}

#[derive(Debug, Serialize)]
struct ChallengeStartResponse<T: Serialize> {
    challenge_id: ChallengeId,
    options: T,
}

#[derive(Debug, Deserialize)]
struct RegisterFinishRequest {
    challenge_id: ChallengeId,
    response: RegisterPublicKeyCredential,
}

#[derive(Debug, Serialize)]
struct RegisterFinishResponse {
    credential_id: String,
    csrf_token: String,
}

#[derive(Debug, Deserialize)]
struct LoginFinishRequest {
    challenge_id: ChallengeId,
    response: PublicKeyCredential,
}

#[derive(Debug, Serialize)]
struct LoginFinishResponse {
    credential_id: String,
    csrf_token: String,
}

/// Start a first-device registration ceremony.
///
/// First-device is the ONLY registration path this slice supports.
/// Adding subsequent devices goes through the setup-token flow in
/// slice 6 (which reuses `WebAuthnService::start_registration` but
/// gates the state differently).
///
/// Two guards — both enforced again inside `register_finish`'s
/// `transact` closure so a race can't slip past the pre-flight:
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
) -> Result<Json<ChallengeStartResponse<CreationChallengeResponse>>, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    if !matches!(access, AccessMethod::Localhost) {
        return Err(ApiError::Forbidden(
            "first-device registration must originate from localhost",
        ));
    }

    // Single snapshot for this handler: we use it both for the
    // "no credentials yet" check and for the `excludeCredentials`
    // argument. The authoritative re-check happens inside
    // `register_finish`'s transact closure; this path is the
    // fast-fail so the user doesn't do a whole biometric prompt only
    // to be told "already initialised" at the end.
    let snap = state.auth_store.snapshot().await;
    if !snap.credentials.is_empty() {
        return Err(ApiError::Conflict(
            "instance already initialised; additional devices must pair via setup token",
        ));
    }

    let (id, ccr) = state
        .webauthn
        .start_registration(
            fresh_user_handle(),
            "katulong",
            "Katulong",
            &snap.credentials,
            SystemTime::now(),
        )
        .map_err(ApiError::from)?;
    Ok(Json(ChallengeStartResponse {
        challenge_id: id,
        options: ccr,
    }))
}

/// Finish the first-device registration, persist the credential, and
/// mint a session cookie bound to it.
///
/// The localhost check is outside `transact` (socket state doesn't
/// change under the mutex). The "no credentials yet" check is INSIDE
/// `transact` so it evaluates under the same lock that will do the
/// write — without this, two concurrent finishes could each pass the
/// pre-flight check on separate snapshots and both end up upserting a
/// credential on what was supposed to be a single-device install.
async fn register_finish(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    if !matches!(access, AccessMethod::Localhost) {
        return Err(ApiError::Forbidden(
            "first-device registration must originate from localhost",
        ));
    }

    let now = SystemTime::now();
    let credential = state
        .webauthn
        .finish_registration(&body.challenge_id, &body.response, now)
        .inspect_err(|e| {
            // Log failed ceremonies at `warn` so brute-force or replay
            // attempts are visible in operator logs. The challenge id
            // is safe to log — it's an opaque server-issued handle,
            // not the attestation response bytes.
            tracing::warn!(
                challenge_id = %body.challenge_id,
                error = %e,
                "registration ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

    // The credentials.is_empty() re-check inside the closure is the
    // authoritative TOCTOU-safe enforcement — a second concurrent
    // finisher will see state already containing the first winner's
    // credential and bail out with StateConflict (→ 409).
    let credential_clone = credential.clone();
    let session = state
        .auth_store
        .transact(move |s| {
            if !s.credentials.is_empty() {
                return Err(AuthError::StateConflict(
                    "instance already initialised by a concurrent registration",
                ));
            }
            let session = Session::mint(credential_clone.id.clone(), now, SESSION_TTL);
            let next = s
                .upsert_credential(credential_clone.clone())
                .upsert_session(session.clone());
            Ok((next, session))
        })
        .await
        .map_err(ApiError::from)?;

    tracing::info!(
        credential_id = %credential.id,
        "registered first device; session minted"
    );

    Ok(session_cookie_response(
        StatusCode::CREATED,
        &session.token,
        state.config.cookie_secure,
        Json(RegisterFinishResponse {
            credential_id: credential.id,
            csrf_token: session.csrf_token,
        }),
    ))
}

/// Start an authentication ceremony. Public — the ceremony itself
/// gates who actually passes.
async fn login_start(
    State(state): State<AppState>,
) -> Result<Json<ChallengeStartResponse<RequestChallengeResponse>>, ApiError> {
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
    Ok(Json(ChallengeStartResponse {
        challenge_id: id,
        options: rcr,
    }))
}

/// Finish an authentication ceremony, persist the counter update, and
/// mint a session cookie.
async fn login_finish(
    State(state): State<AppState>,
    Json(body): Json<LoginFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let now = SystemTime::now();
    let snap = state.auth_store.snapshot().await;
    let verified = state
        .webauthn
        .finish_authentication(&body.challenge_id, &body.response, &snap.credentials, now)
        .inspect_err(|e| {
            tracing::warn!(
                challenge_id = %body.challenge_id,
                error = %e,
                "login ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

    // `updated_credential` is `Some` iff the authenticator reported a
    // counter or backup-state change. Persisting it advances the
    // monotonicity baseline inside the stored Passkey blob — see
    // `VerifiedAuthentication` docs for why this MUST happen.
    //
    // A theoretical improvement: recompute `updated_credential` from
    // the live credential inside `transact` rather than from `snap`,
    // so two simultaneous logins can't regress each other's counter.
    // Deferred to slice 6 alongside logout/revocation lifecycle work
    // — the scenario requires two successful concurrent logins with
    // the same passkey (rare; self-corrects on the next auth) and a
    // cleaner fix wants `Credential::apply(&AuthenticationResult)`
    // exposed, which is a bigger refactor than the risk justifies now.
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

    tracing::info!(
        credential_id = %verified.credential_id,
        "login succeeded; session minted"
    );

    Ok(session_cookie_response(
        StatusCode::OK,
        &session.token,
        state.config.cookie_secure,
        Json(LoginFinishResponse {
            credential_id: verified.credential_id,
            csrf_token: session.csrf_token,
        }),
    ))
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
