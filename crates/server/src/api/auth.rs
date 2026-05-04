//! Authentication HTTP routes.
//!
//! Six endpoints covering the full auth surface:
//!
//! - `GET  /auth/status`          — public; `{setup, accessMethod}`
//! - `POST /auth/register/options` — branched on optional `setupToken`:
//!     - absent → localhost-only, fresh install
//!     - present → public, setup-token-gated additional-device pair
//!   Returns a bare `CreationChallengeResponse` either way.
//! - `POST /auth/register/verify` — same branching as `/options`;
//!   mints a session cookie on success.
//! - `POST /auth/login/options`   — public; bare `RequestChallengeResponse`
//! - `POST /auth/login/verify`    — public; updates counter + mints session
//! - `POST /auth/logout`          — auth + CSRF; localhost → 409
//!
//! Phase 0a step 4 collapsed the standalone `/auth/pair/*`
//! routes into `/auth/register/*`. The Node frontend
//! (`public/login.js`) only ever called `/auth/register/*`
//! and branched on whether it had a setup token to send;
//! mirroring that here means the Rust server is drop-in
//! compatible with the existing Node-built UI as well as
//! the WASM `<Login/>` / `<Register/>` components.
//!
//! The wire shapes match the Node implementation
//! (`lib/routes/auth-routes.js`) byte-for-byte so the JS frontend
//! drives the Rust server unchanged. In particular: the start
//! endpoints return WebAuthn options at the JSON top level (no
//! `challenge_id` envelope), and the verify endpoints recover the
//! challenge from `credential.response.clientDataJSON.challenge` —
//! the same `extractChallenge()` pattern the Node handler uses.
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
    AuthFinishResponse, AuthStatusResponse, CreationChallengeResponse, LoginFinishRequest,
    RegisterFinishRequest, RegisterOptionsRequest, RequestChallengeResponse,
};
use std::net::SocketAddr;
use std::time::SystemTime;

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        // PUBLIC: reports whether the instance has any credentials and
        // which access mode this request is coming from; the client
        // uses this to pick between register/login UI.
        .route("/auth/status", get(status))
        // PUBLIC (but state-gated): registration. Branches inside the
        // handler on the optional `setupToken` body field:
        //   - absent → first-device bootstrap; localhost-only AND
        //     refused once any credential exists.
        //   - present → additional-device pair; the token value is the
        //     gate (anyone with a valid plaintext token can pair).
        // Token validity and "no credentials yet" are both re-checked
        // inside `transact` so the mutex is the authoritative
        // enforcement point. Phase 0a step 4 merged the dedicated
        // `/auth/pair/*` routes into these so the Node frontend
        // (which only ever calls `/auth/register/*`) drives the Rust
        // server unchanged.
        .route("/auth/register/options", post(register_start))
        .route("/auth/register/verify", post(register_finish))
        // PUBLIC: anyone can try to log in. The ceremony itself gates
        // who actually succeeds.
        .route("/auth/login/options", post(login_start))
        .route("/auth/login/verify", post(login_finish))
        // PROTECTED + CSRF: end the caller's session. Localhost
        // callers get a 409 — there's no session to end, and the
        // UI shouldn't offer logout for physical-access peers (Node
        // scar `23981ca`).
        .route("/auth/logout", post(logout))
}

async fn status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    _authed: Option<Authenticated>,
) -> Json<AuthStatusResponse> {
    // Wire shape mirrors Node's `lib/routes/auth-routes.js`:
    // `{ setup, accessMethod }`. The `Option<Authenticated>`
    // parameter stays in the signature so the auth-middleware
    // wiring exercises the cookie-validation path on this
    // public endpoint (logging side effects, lockout pruning),
    // but the resulting bool no longer round-trips through
    // status — a sibling PR adds `/api/me` for the frontend
    // to recover that signal.
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    let snap = state.auth_store.snapshot().await;
    Json(AuthStatusResponse {
        setup: !snap.credentials.is_empty(),
        access_method: access.into(),
    })
}

/// Upper bound on the raw `setupToken` value accepted by the
/// register endpoints. Legitimate tokens are 64 hex chars
/// (32 bytes from CSPRNG, hex-encoded); 128 gives headroom.
/// The cap exists to stop an unauthenticated caller from
/// submitting a megabyte-long string and forcing
/// `find_redeemable_setup_token` to run scrypt verify against
/// every stored token with a megabyte input per call — a CPU
/// amplification DoS vector because the no-token branch is
/// localhost-gated but the token branch is fully public.
const SETUP_TOKEN_MAX_LEN: usize = 128;

/// Normalise an optional `setupToken` from the request body.
/// Node's frontend sends `setupToken: ""` when the input is
/// empty (it doesn't trim before submitting); treat empty
/// strings as absent so the no-token branch fires for both
/// shapes. Anything longer than `SETUP_TOKEN_MAX_LEN` is
/// rejected before it reaches scrypt verify.
fn normalise_setup_token(raw: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = raw else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > SETUP_TOKEN_MAX_LEN {
        tracing::warn!(
            length = value.len(),
            "register: setupToken exceeds maximum length"
        );
        return Err(ApiError::BadRequest("setupToken exceeds maximum length"));
    }
    Ok(Some(value))
}

/// Start a registration ceremony.
///
/// Two branches selected by `body.setupToken`:
///
/// 1. **No token (first-device bootstrap)** — refuses non-localhost
///    callers (a tunnel-bound register would let anyone with the URL
///    enrol a key on a fresh install) and refuses any call after the
///    first credential exists. Both invariants are re-checked inside
///    `register_finish`'s `transact` closure so a race can't slip past
///    the pre-flight.
///
/// 2. **Token present (additional-device pair)** — public; the token
///    value IS the gate. `find_redeemable_setup_token` walks every
///    stored token and runs scrypt verify (no short-circuit — the
///    timing channel is the same as login). Only live, unconsumed,
///    unexpired tokens pass. Token validity is re-validated under the
///    state mutex in `register_finish` to close the TOCTOU window
///    against a concurrent revoke between start and finish.
///
/// Both branches return a bare `CreationChallengeResponse` at the JSON
/// top level (Node's `res.json(opts)` shape).
async fn register_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<RegisterOptionsRequest>,
) -> Result<Json<CreationChallengeResponse>, ApiError> {
    let setup_token = normalise_setup_token(body.setup_token)?;
    let now = SystemTime::now();

    let (user_handle, credentials) = if let Some(plaintext) = setup_token.as_ref() {
        // Token-gated branch: skip the localhost check, validate the
        // token, then ensure a stable user handle is persisted before
        // the WebAuthn ceremony. Token re-validation under the mutex
        // happens in `register_finish`; the pre-flight here is a
        // fast-fail for the common (non-racing) case.
        let snap = state.auth_store.snapshot().await;
        if snap.find_redeemable_setup_token(plaintext, now).is_none() {
            tracing::warn!("register_start: setup token not redeemable");
            return Err(ApiError::Unauthorized);
        }
        let user_handle = state
            .auth_store
            .transact(|s| {
                let (uh, next) = s.user_handle_or_init();
                Ok((next, uh))
            })
            .await
            .map_err(ApiError::from)?;
        (user_handle, snap.credentials.clone())
    } else {
        // No-token branch: physical access is required to bootstrap
        // the first device, since there's nothing to authenticate
        // against yet.
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        let access = AccessMethod::classify(peer, host);
        if !matches!(access, AccessMethod::Localhost) {
            // Generic "forbidden" — the descriptive variant would
            // confirm to a remote scanner that this is a katulong
            // instance with a first-device registration path gated on
            // localhost. Operators needing detail can read the log.
            tracing::warn!("rejecting remote request to first-device registration");
            return Err(ApiError::Forbidden("forbidden"));
        }
        // Get-or-init the stable user handle AND enforce the "no
        // credentials yet" invariant atomically. The same re-check
        // appears in `register_finish`'s transact closure to close
        // the TOCTOU window between start and finish.
        state
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
            .map_err(ApiError::from)?
    };

    let ccr = state
        .webauthn
        .start_registration(user_handle, "katulong", "Katulong", &credentials, now)
        .map_err(ApiError::from)?;
    Ok(Json(ccr))
}

/// Finish a registration ceremony, persist the credential, and mint a
/// session cookie. Branches on `body.setupToken` exactly like
/// `register_start`.
///
/// Both branches enforce their guards INSIDE `transact`:
///   - No-token: `credentials.is_empty()` re-check (TOCTOU-safe vs a
///     concurrent first-device finish).
///   - Token: `find_redeemable_setup_token` re-check (TOCTOU-safe vs a
///     concurrent revoke between start and finish), then
///     `consume_setup_token` linking the new credential id to the
///     token id (Node scar `7742ac3` — revoke cascades to remove the
///     paired device).
async fn register_finish(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<RegisterFinishRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let setup_token = normalise_setup_token(body.setup_token.clone())?;
    let now = SystemTime::now();

    if setup_token.is_none() {
        // No-token branch is localhost-only. Socket state doesn't
        // change under the mutex, so this gate stays outside transact;
        // the `credentials.is_empty()` re-check inside the transact
        // closure is the authoritative invariant.
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        let access = AccessMethod::classify(peer, host);
        if !matches!(access, AccessMethod::Localhost) {
            tracing::warn!("rejecting remote request to first-device registration");
            return Err(ApiError::Forbidden("forbidden"));
        }
    }

    // Run the WebAuthn ceremony. The pair branch needs the
    // setup_token_id stamped onto the credential — `finish_paired_registration`
    // owns the bidirectional link invariant (credential ↔ setup token)
    // so the handler never constructs that link by hand.
    let credential = if let Some(plaintext) = setup_token.as_ref() {
        // Pre-flight token resolve so we can pass the id to the
        // ceremony; the authoritative re-check happens under the
        // state mutex below.
        let snap = state.auth_store.snapshot().await;
        let token = snap
            .find_redeemable_setup_token(plaintext, now)
            .ok_or_else(|| {
                tracing::warn!("register_finish: setup token not redeemable");
                ApiError::Unauthorized
            })?;
        let setup_token_id = token.id.clone();
        state
            .webauthn
            .finish_paired_registration(&body.credential, setup_token_id, now)
            .inspect_err(|e| {
                tracing::warn!(
                    credential_id = %body.credential.id,
                    error = %e,
                    "pair ceremony failed"
                );
            })
            .map_err(ApiError::from)?
    } else {
        state
            .webauthn
            .finish_registration(&body.credential, now)
            .inspect_err(|e| {
                // Log failed ceremonies at `warn` so brute-force or
                // replay attempts are visible in operator logs. The
                // credential id is safe to log; the attestation
                // response bytes are not logged.
                tracing::warn!(
                    credential_id = %body.credential.id,
                    error = %e,
                    "registration ceremony failed"
                );
            })
            .map_err(ApiError::from)?
    };

    // Stamp the human-facing labels onto the credential before it goes
    // to disk. `finish_registration` doesn't see the request body
    // (it's a pure WebAuthn primitive); the handler is the only place
    // that has both the verified credential AND the operator-supplied
    // `deviceName`/`userAgent`. Defaults to empty when missing — Node
    // uses the same `||''` tolerance.
    let credential = katulong_auth::Credential {
        name: body.device_name.clone().filter(|n| !n.is_empty()),
        user_agent: body.user_agent.clone().unwrap_or_default(),
        ..credential
    };

    let new_credential = credential.clone();
    let setup_token_for_closure = setup_token.clone();
    let (plaintext_token, minted_session, paired_token_id) = state
        .auth_store
        .transact(move |s| {
            if let Some(plaintext) = setup_token_for_closure.as_ref() {
                // Re-validate the token under the mutex: a concurrent
                // revoke between start and finish must NOT succeed in
                // pairing. Re-resolve from the plaintext so the id we
                // commit against is whatever the live state says is
                // redeemable RIGHT NOW.
                let Some(token) = s.find_redeemable_setup_token(plaintext, now) else {
                    return Err(AuthError::StateConflict(
                        "setup token no longer redeemable (revoked, consumed, or expired)",
                    ));
                };
                let token_id = token.id.clone();
                let (plaintext_session, session) =
                    Session::mint(new_credential.id.clone(), now, SESSION_TTL);
                let next = s
                    .upsert_credential(new_credential.clone())
                    .consume_setup_token(&token_id, &new_credential.id, now)
                    .upsert_session(session.clone());
                Ok((next, (plaintext_session, session, Some(token_id))))
            } else {
                // The credentials.is_empty() re-check inside the
                // closure is the authoritative TOCTOU-safe enforcement
                // — a second concurrent finisher will see state already
                // containing the first winner's credential and bail
                // out with StateConflict (→ 409).
                if !s.credentials.is_empty() {
                    return Err(AuthError::StateConflict(
                        "instance already initialised by a concurrent registration",
                    ));
                }
                let (plaintext_session, session) =
                    Session::mint(new_credential.id.clone(), now, SESSION_TTL);
                let next = s
                    .upsert_credential(new_credential.clone())
                    .upsert_session(session.clone());
                Ok((next, (plaintext_session, session, None)))
            }
        })
        .await
        .map_err(ApiError::from)?;

    if let Some(token_id) = paired_token_id.as_ref() {
        tracing::info!(
            credential_id = %credential.id,
            setup_token_id = %token_id,
            "paired new device; session minted"
        );
    } else {
        tracing::info!(
            credential_id = %credential.id,
            "registered first device; session minted"
        );
    }

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
) -> Result<Json<RequestChallengeResponse>, ApiError> {
    let snap = state.auth_store.snapshot().await;
    if snap.credentials.is_empty() {
        // Fresh-install case. Return an explicit conflict rather than
        // letting webauthn-rs surface "no usable credentials" as a 401;
        // the client should route to the register flow instead.
        return Err(ApiError::Conflict(
            "no credentials registered; first device must register via /auth/register/options",
        ));
    }
    let rcr = state
        .webauthn
        .start_authentication(&snap.credentials, SystemTime::now())
        .map_err(ApiError::from)?;
    Ok(Json(rcr))
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
        .finish_authentication(&body.credential, now)
        .inspect_err(|e| {
            tracing::warn!(
                credential_id = %body.credential.id,
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
            // Stamp `last_used_at` on the credential we just authed
            // against. Done inside `transact` so the same write that
            // bumps the WebAuthn counter also records usage — single
            // writer, no extra TOCTOU surface for the device-list UI.
            next = next.touch_credential(&credential_id, now);
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
