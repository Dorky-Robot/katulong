//! Authentication HTTP routes.
//!
//! Eight endpoints covering the full auth surface:
//!
//! - `GET  /api/auth/status`          — public; access mode + install state + authenticated
//! - `POST /api/auth/register/start`  — localhost-only, fresh install
//! - `POST /api/auth/register/finish` — localhost-only, fresh install; mints session
//! - `POST /api/auth/login/start`     — public
//! - `POST /api/auth/login/finish`    — public; updates counter + mints session
//! - `POST /api/auth/pair/start`      — public, setup-token-gated
//! - `POST /api/auth/pair/finish`     — public; links credential to token + mints session
//! - `POST /api/auth/logout`          — auth + CSRF; localhost → 409
//!
//! Setup-token management (list / create / revoke) lives in
//! `api::tokens`. Those routes share the same `CsrfProtected` pattern
//! as logout for state-changing verbs.
//!
//! Every successful ceremony writes through `AuthStore::transact` so
//! the "compute new state, persist atomically, swap in memory"
//! contract holds. Invariants that gate a write (e.g., "first device
//! only", "setup token still redeemable") are checked **inside** the
//! transact closure so the mutex is the authoritative enforcement
//! point — a pre-flight guard stays as a fast-fail for the common
//! non-racing case.

use crate::access::AccessMethod;
use crate::api::csrf::CsrfProtected;
use crate::api::error::ApiError;
use crate::api::extract::JsonBody;
use crate::auth_middleware::{AuthContext, Authenticated};
use crate::cookie::{build_clear_cookie, build_set_cookie};
use crate::state::AppState;
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use katulong_auth::{AuthError, Session, SESSION_TTL};
use katulong_shared::wire::{
    AuthFinishResponse, ChallengeStartResponse, CreationChallengeResponse,
    LoginFinishRequest, PairFinishRequest, PairStartRequest, PairStartResponse,
    RegisterFinishRequest, RequestChallengeResponse,
};
use serde::Serialize;
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
        // Additional-device registration uses the pair flow below.
        .route("/api/auth/register/start", post(register_start))
        .route("/api/auth/register/finish", post(register_finish))
        // PUBLIC: anyone can try to log in. The ceremony itself gates
        // who actually succeeds.
        .route("/api/auth/login/start", post(login_start))
        .route("/api/auth/login/finish", post(login_finish))
        // PUBLIC: pair a new device using a setup token issued by an
        // authenticated admin. The token value IS the gate — anyone
        // with a valid plaintext token can pair. Token validity and
        // single-use semantics are enforced inside `transact`.
        .route("/api/auth/pair/start", post(pair_start))
        .route("/api/auth/pair/finish", post(pair_finish))
        // PROTECTED + CSRF: end the caller's session. Localhost
        // callers get a 409 — there's no session to end, and the
        // UI shouldn't offer logout for physical-access peers (Node
        // scar `23981ca`).
        .route("/api/auth/logout", post(logout))
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
        // Generic "forbidden" — the descriptive variant would confirm
        // to a remote scanner that this is a katulong instance with a
        // first-device registration path gated on localhost. Operators
        // needing detail can read the server log.
        tracing::warn!("rejecting remote request to first-device registration");
        return Err(ApiError::Forbidden("forbidden"));
    }

    // Get-or-init the stable user handle AND enforce the "no
    // credentials yet" invariant atomically. `user_handle_or_init`
    // returns the existing handle on a fresh call for the same
    // install (idempotent) or mints a fresh one on first use. Doing
    // this inside `transact` means the handle persists before the
    // ceremony runs, so `register_finish`'s transact closure reads
    // the same value even if a second device later pairs in.
    //
    // This is the authoritative `credentials.is_empty()` check — the
    // same re-check appears in `register_finish`'s transact closure
    // to close the TOCTOU window between start and finish.
    let (user_handle, credentials) = state
        .auth_store
        .transact(|s| {
            if !s.credentials.is_empty() {
                return Err(AuthError::StateConflict(
                    "instance already initialised; additional devices must pair via setup token",
                ));
            }
            let (uh, next) = s.user_handle_or_init();
            let creds = next.credentials.clone();
            Ok((next, (uh, creds)))
        })
        .await
        .map_err(ApiError::from)?;

    let (id, ccr) = state
        .webauthn
        .start_registration(
            user_handle,
            "katulong",
            "Katulong",
            &credentials,
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
    JsonBody(body): JsonBody<RegisterFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    if !matches!(access, AccessMethod::Localhost) {
        // Generic "forbidden" — the descriptive variant would confirm
        // to a remote scanner that this is a katulong instance with a
        // first-device registration path gated on localhost. Operators
        // needing detail can read the server log.
        tracing::warn!("rejecting remote request to first-device registration");
        return Err(ApiError::Forbidden("forbidden"));
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
    let new_credential = credential.clone();
    let (plaintext_token, minted_session) = state
        .auth_store
        .transact(move |s| {
            if !s.credentials.is_empty() {
                return Err(AuthError::StateConflict(
                    "instance already initialised by a concurrent registration",
                ));
            }
            let (plaintext, session) = Session::mint(new_credential.id.clone(), now, SESSION_TTL);
            let next = s
                .upsert_credential(new_credential.clone())
                .upsert_session(session.clone());
            Ok((next, (plaintext, session)))
        })
        .await
        .map_err(ApiError::from)?;

    tracing::info!(
        credential_id = %credential.id,
        "registered first device; session minted"
    );

    Ok(session_cookie_response(
        StatusCode::CREATED,
        &plaintext_token,
        state.config.cookie_secure,
        Json(AuthFinishResponse {
            credential_id: credential.id,
            csrf_token: minted_session.csrf_token,
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
    JsonBody(body): JsonBody<LoginFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let now = SystemTime::now();
    let verified = state
        .webauthn
        .finish_authentication(&body.challenge_id, &body.response, now)
        .inspect_err(|e| {
            tracing::warn!(
                challenge_id = %body.challenge_id,
                error = %e,
                "login ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

    // All state reads AND the counter update happen inside `transact`
    // so there's no window for another login to regress the counter
    // baseline under concurrent double-submit. Revocation during the
    // challenge window also fails closed here: if the credential was
    // deleted between `start_authentication` and this point, the
    // lookup returns `None` and we surface `StateConflict` (→ 409)
    // rather than minting a session against a pulled credential.
    let credential_id = verified.credential_id.clone();
    let (plaintext_token, minted_session) = state
        .auth_store
        .transact(move |s| {
            let cred = s.find_credential(&credential_id).ok_or(
                AuthError::StateConflict("credential revoked during authentication ceremony"),
            )?;
            let updated = cred.apply_authentication(&verified.result)?;
            let (plaintext, session) = Session::mint(credential_id.clone(), now, SESSION_TTL);
            let mut next = s.clone();
            if let Some(updated_cred) = updated {
                next = next.upsert_credential(updated_cred);
            }
            next = next.upsert_session(session.clone());
            Ok((next, (plaintext, session)))
        })
        .await
        .map_err(ApiError::from)?;

    tracing::info!(
        credential_id = %verified.credential_id,
        "login succeeded; session minted"
    );

    Ok(session_cookie_response(
        StatusCode::OK,
        &plaintext_token,
        state.config.cookie_secure,
        Json(AuthFinishResponse {
            credential_id: verified.credential_id,
            csrf_token: minted_session.csrf_token,
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

// ============== pair flow (setup-token-gated registration) ==============

/// Validate the plaintext token, start a WebAuthn registration
/// ceremony, and return the challenge. Public — anyone with a valid
/// token can pair.
///
/// Token validation uses `find_redeemable_setup_token` which walks
/// every token and runs scrypt verify (no short-circuit — the slice-2
/// comment calls out the timing-channel concern). Only live,
/// non-consumed tokens pass.
/// Upper bound on the raw `setup_token` value accepted by
/// `pair_start`. Legitimate tokens are 64 hex chars (32 bytes from
/// CSPRNG, hex-encoded); 128 gives headroom. The cap exists to stop
/// an unauthenticated caller from submitting a megabyte-long string
/// and forcing `find_redeemable_setup_token` to run scrypt verify
/// against every stored token with a megabyte input per call — a CPU
/// amplification DoS vector because pair_start is public.
const SETUP_TOKEN_MAX_LEN: usize = 128;

async fn pair_start(
    State(state): State<AppState>,
    JsonBody(body): JsonBody<PairStartRequest>,
) -> Result<Json<PairStartResponse>, ApiError> {
    if body.setup_token.len() > SETUP_TOKEN_MAX_LEN {
        tracing::warn!(
            length = body.setup_token.len(),
            "pair_start: setup_token exceeds maximum length"
        );
        return Err(ApiError::BadRequest("setup_token exceeds maximum length"));
    }

    let now = SystemTime::now();

    // Ensure the stable user handle is persisted before we hand it
    // to the WebAuthn ceremony. `user_handle_or_init` is idempotent:
    // returns the existing value on a live install, mints + persists
    // a fresh one on the pathological path where tokens somehow
    // exist without a handle. Running this inside `transact` means
    // the handle that pair_finish reads back is the SAME value that
    // was used here, even across concurrent pair_start calls.
    let user_handle = state
        .auth_store
        .transact(|s| {
            let (uh, next) = s.user_handle_or_init();
            Ok((next, uh))
        })
        .await
        .map_err(ApiError::from)?;

    // A separate snapshot for token validation + excludeCredentials.
    // `find_redeemable_setup_token` walks every record with scrypt
    // verify, so a concurrent mutation doesn't matter — the
    // authoritative token re-check happens in pair_finish's transact.
    let snap = state.auth_store.snapshot().await;
    let token = snap
        .find_redeemable_setup_token(&body.setup_token, now)
        .ok_or_else(|| {
            tracing::warn!("pair_start: setup token not redeemable");
            ApiError::Unauthorized
        })?;
    let setup_token_id = token.id.clone();

    let (challenge_id, ccr) = state
        .webauthn
        .start_registration(
            user_handle,
            "katulong",
            "Katulong",
            &snap.credentials,
            now,
        )
        .map_err(ApiError::from)?;

    Ok(Json(PairStartResponse {
        challenge_id,
        setup_token_id,
        options: ccr,
    }))
}

/// Complete the pair ceremony. Verifies the challenge, verifies the
/// setup token is STILL redeemable under the mutex (TOCTOU-safe vs a
/// concurrent revoke between start and finish), consumes the token,
/// persists the new credential with a bidirectional link to the
/// token, and mints a session cookie.
///
/// The bidirectional link (token ↔ credential, Node scar `7742ac3`)
/// means that revoking the setup token later also cascades to
/// removing this device. We set it here so future
/// `remove_setup_token(id)` calls can follow the link.
async fn pair_finish(
    State(state): State<AppState>,
    JsonBody(body): JsonBody<PairFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let now = SystemTime::now();
    // The auth crate owns the bidirectional link invariant (credential
    // ↔ setup token). `finish_paired_registration` returns a
    // credential already stamped with `setup_token_id` — the handler
    // never constructs that link by hand.
    let credential = state
        .webauthn
        .finish_paired_registration(
            &body.challenge_id,
            &body.response,
            body.setup_token_id.clone(),
            now,
        )
        .inspect_err(|e| {
            tracing::warn!(
                challenge_id = %body.challenge_id,
                error = %e,
                "pair ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

    let new_credential = credential.clone();
    let setup_token_id = body.setup_token_id.clone();
    let (plaintext_token, minted_session) = state
        .auth_store
        .transact(move |s| {
            // Re-validate the token under the mutex: a concurrent
            // revoke between pair_start and pair_finish must NOT
            // succeed in pairing. `find_setup_token` by id because at
            // this point we're committing against the specific token
            // the client referenced; we also require it to still be
            // redeemable.
            let Some(token) = s.find_setup_token(&setup_token_id) else {
                return Err(AuthError::StateConflict(
                    "setup token revoked during pair ceremony",
                ));
            };
            if !token.is_redeemable(now) {
                return Err(AuthError::StateConflict(
                    "setup token no longer redeemable (consumed or expired)",
                ));
            }

            let (plaintext, session) =
                Session::mint(new_credential.id.clone(), now, SESSION_TTL);
            let next = s
                .upsert_credential(new_credential.clone())
                .consume_setup_token(&setup_token_id, &new_credential.id, now)
                .upsert_session(session.clone());
            Ok((next, (plaintext, session)))
        })
        .await
        .map_err(ApiError::from)?;

    tracing::info!(
        credential_id = %credential.id,
        setup_token_id = %body.setup_token_id,
        "paired new device; session minted"
    );

    Ok(session_cookie_response(
        StatusCode::CREATED,
        &plaintext_token,
        state.config.cookie_secure,
        Json(AuthFinishResponse {
            credential_id: credential.id,
            csrf_token: minted_session.csrf_token,
        }),
    ))
}

// ============== logout ==============

async fn logout(
    State(state): State<AppState>,
    CsrfProtected(ctx): CsrfProtected,
) -> Result<impl IntoResponse, ApiError> {
    // Localhost has no session — nothing to end. Return 409 rather
    // than silently succeeding so the UI can surface "you're
    // physically present; logout doesn't apply." Node reached the
    // same conclusion (`23981ca`): the logout button is hidden for
    // localhost callers; a request arriving here from localhost is
    // therefore either a buggy client or a probe. Treating it as a
    // conflict keeps the behaviour observable.
    let AuthContext::Remote {
        plaintext_token,
        credential,
        ..
    } = ctx
    else {
        return Err(ApiError::Conflict("localhost peer has no session to end"));
    };

    state
        .auth_store
        .transact(move |s| Ok((s.remove_session(&plaintext_token), ())))
        .await
        .map_err(ApiError::from)?;

    let clear = build_clear_cookie(state.config.cookie_secure);
    tracing::info!(
        credential_id = %credential.id,
        "logout succeeded; session removed"
    );
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, clear)]))
}
