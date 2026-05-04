//! Authentication HTTP routes.
//!
//! Eight endpoints covering the full auth surface:
//!
//! - `GET  /auth/status`          — public; `{setup, accessMethod}`
//! - `POST /auth/register/options` — localhost-only, fresh install; bare `CreationChallengeResponse`
//! - `POST /auth/register/verify` — localhost-only, fresh install; mints session
//! - `POST /auth/login/options`   — public; bare `RequestChallengeResponse`
//! - `POST /auth/login/verify`    — public; updates counter + mints session
//! - `POST /auth/pair/options`    — public, setup-token-gated; bare `CreationChallengeResponse`
//! - `POST /auth/pair/verify`     — public; takes plaintext `setup_token`; mints session
//! - `POST /auth/logout`          — auth + CSRF; localhost → 409
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
    PairFinishRequest, PairStartRequest, RegisterFinishRequest, RequestChallengeResponse,
};
use std::net::SocketAddr;
use std::time::SystemTime;

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        // PUBLIC: reports whether the instance has any credentials and
        // which access mode this request is coming from; the client
        // uses this to pick between register/login UI.
        .route("/auth/status", get(status))
        // PUBLIC (but state-gated): first-device registration. Only
        // works from localhost AND only when no credentials exist.
        // Additional-device registration uses the pair flow below.
        .route("/auth/register/options", post(register_start))
        .route("/auth/register/verify", post(register_finish))
        // PUBLIC: anyone can try to log in. The ceremony itself gates
        // who actually succeeds.
        .route("/auth/login/options", post(login_start))
        .route("/auth/login/verify", post(login_finish))
        // PUBLIC: pair a new device using a setup token issued by an
        // authenticated admin. The token value IS the gate — anyone
        // with a valid plaintext token can pair. Token validity and
        // single-use semantics are enforced inside `transact`.
        .route("/auth/pair/options", post(pair_start))
        .route("/auth/pair/verify", post(pair_finish))
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
) -> Result<Json<CreationChallengeResponse>, ApiError> {
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

    let ccr = state
        .webauthn
        .start_registration(
            user_handle,
            "katulong",
            "Katulong",
            &credentials,
            SystemTime::now(),
        )
        .map_err(ApiError::from)?;
    Ok(Json(ccr))
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
        .finish_registration(&body.credential, now)
        .inspect_err(|e| {
            // Log failed ceremonies at `warn` so brute-force or replay
            // attempts are visible in operator logs. The credential id
            // is safe to log; the attestation response bytes are not
            // logged.
            tracing::warn!(
                credential_id = %body.credential.id,
                error = %e,
                "registration ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

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
) -> Result<Json<CreationChallengeResponse>, ApiError> {
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
    let _token = snap
        .find_redeemable_setup_token(&body.setup_token, now)
        .ok_or_else(|| {
            tracing::warn!("pair_start: setup token not redeemable");
            ApiError::Unauthorized
        })?;

    // Bare `CreationChallengeResponse` at the top level — Node
    // returns `res.json(opts)` from
    // `lib/routes/auth-routes.js` without a wrapper. The
    // `setup_token_id` is no longer echoed; pair_finish takes
    // the plaintext token again and re-resolves the id under
    // the state mutex.
    let ccr = state
        .webauthn
        .start_registration(
            user_handle,
            "katulong",
            "Katulong",
            &snap.credentials,
            now,
        )
        .map_err(ApiError::from)?;

    Ok(Json(ccr))
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
    if body.setup_token.len() > SETUP_TOKEN_MAX_LEN {
        tracing::warn!(
            length = body.setup_token.len(),
            "pair_finish: setup_token exceeds maximum length"
        );
        return Err(ApiError::BadRequest("setup_token exceeds maximum length"));
    }

    let now = SystemTime::now();

    // Resolve the plaintext setup token to its server-side id
    // before running the WebAuthn ceremony. Node does the same
    // (re-validates the token in the verify handler), and we
    // re-validate again under the state mutex below — the
    // pre-flight here is a fast-fail for the common case.
    let snap = state.auth_store.snapshot().await;
    let token = snap
        .find_redeemable_setup_token(&body.setup_token, now)
        .ok_or_else(|| {
            tracing::warn!("pair_finish: setup token not redeemable");
            ApiError::Unauthorized
        })?;
    let setup_token_id = token.id.clone();

    // The auth crate owns the bidirectional link invariant (credential
    // ↔ setup token). `finish_paired_registration` returns a
    // credential already stamped with `setup_token_id` — the handler
    // never constructs that link by hand.
    let credential = state
        .webauthn
        .finish_paired_registration(&body.credential, setup_token_id.clone(), now)
        .inspect_err(|e| {
            tracing::warn!(
                credential_id = %body.credential.id,
                error = %e,
                "pair ceremony failed"
            );
        })
        .map_err(ApiError::from)?;

    // Stamp the human-facing labels supplied with the pair request.
    // Same reasoning as `register_finish` — the auth crate stays
    // unaware of the request shape; the handler stitches the user-
    // visible metadata onto the verified credential.
    let credential = katulong_auth::Credential {
        name: body.device_name.clone().filter(|n| !n.is_empty()),
        user_agent: body.user_agent.clone().unwrap_or_default(),
        ..credential
    };

    let new_credential = credential.clone();
    let setup_token_plaintext = body.setup_token.clone();
    let (plaintext_token, minted_session) = state
        .auth_store
        .transact(move |s| {
            // Re-validate the token under the mutex: a concurrent
            // revoke between pair_start and pair_finish must NOT
            // succeed in pairing. Re-resolve from the plaintext so
            // the id we commit against is whatever the live state
            // says is redeemable RIGHT NOW — a concurrent
            // delete-then-recreate with the same plaintext (not
            // possible today, but the pattern is robust to future
            // shapes) lands on the live token.
            let Some(token) = s.find_redeemable_setup_token(&setup_token_plaintext, now) else {
                return Err(AuthError::StateConflict(
                    "setup token no longer redeemable (revoked, consumed, or expired)",
                ));
            };
            let token_id = token.id.clone();

            let (plaintext, session) =
                Session::mint(new_credential.id.clone(), now, SESSION_TTL);
            let next = s
                .upsert_credential(new_credential.clone())
                .consume_setup_token(&token_id, &new_credential.id, now)
                .upsert_session(session.clone());
            Ok((next, (plaintext, session)))
        })
        .await
        .map_err(ApiError::from)?;

    tracing::info!(
        credential_id = %credential.id,
        setup_token_id = %setup_token_id,
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
