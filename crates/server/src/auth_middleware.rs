//! Request-level authentication.
//!
//! One extractor, `Authenticated`, that either (a) proves the request is
//! from loopback with a loopback Host, in which case auth is satisfied
//! without a cookie, or (b) carries a valid unexpired session cookie.
//! Anything else rejects with 401.
//!
//! The extractor returns a rich `AuthContext` (not a boolean) so
//! downstream handlers don't have to re-parse the cookie to learn which
//! credential is logged in. That duplication bit the Node port and was
//! consolidated in commit `45f4285`; the Rust port ships with the rich
//! shape from day one.

use crate::access::AccessMethod;
use crate::cookie::extract_session_token;
use crate::state::AppState;
use axum::{
    extract::{ConnectInfo, FromRequestParts, State},
    http::{header, request::Parts, StatusCode},
    response::{IntoResponse, Response},
};
use katulong_auth::{Credential, Session};
use std::net::SocketAddr;
use std::time::SystemTime;

/// The rich result produced when a request is authenticated.
///
/// `Localhost` carries no session — the peer is this machine and that's
/// the whole auth story. `Remote` carries both the session and the
/// credential it was bound to, so handlers that need one or the other
/// don't go back to the store.
///
/// Clippy flags the size imbalance (Remote ≈ 240 bytes, Localhost 0)
/// and suggests boxing `credential`. We decline: `Remote` is the common
/// case on every authenticated remote request, and adding a heap
/// allocation to the hot path to save zeroing 240 stack bytes on the
/// rare `Localhost` path is the wrong tradeoff for single-user
/// katulong. If this ever shows up in a profile, revisit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum AuthContext {
    Localhost,
    Remote { session: Session, credential: Credential },
}

impl AuthContext {
    /// Credential ID if one is bound to this context. `None` for
    /// `Localhost` — there's no registered device involved.
    pub fn credential_id(&self) -> Option<&str> {
        match self {
            Self::Localhost => None,
            Self::Remote { credential, .. } => Some(&credential.id),
        }
    }
}

/// Axum extractor wrapper. Handler signature is
/// `async fn handler(Authenticated(ctx): Authenticated, ...)`.
#[derive(Debug, Clone)]
pub struct Authenticated(pub AuthContext);

/// Rejection produced when authentication fails. Always 401 —
/// distinguishing "no cookie" vs "expired cookie" vs "unknown cookie" in
/// the response body would help an attacker probe valid session shapes,
/// so the client gets the same message regardless.
#[derive(Debug)]
pub struct AuthRejection;

impl IntoResponse for AuthRejection {
    fn into_response(self) -> Response {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for Authenticated {
    type Rejection = AuthRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ConnectInfo(peer) = ConnectInfo::<SocketAddr>::from_request_parts(parts, state)
            .await
            .map_err(|_| AuthRejection)?;
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok());
        let access = AccessMethod::classify(peer, host);
        if matches!(access, AccessMethod::Localhost) {
            return Ok(Authenticated(AuthContext::Localhost));
        }

        let token = parts
            .headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(extract_session_token)
            .ok_or(AuthRejection)?;

        let snapshot = state.auth_store.snapshot().await;
        let now = SystemTime::now();
        let session = snapshot
            .valid_session(&token, now)
            .ok_or(AuthRejection)?
            .clone();
        let credential = snapshot
            .find_credential(&session.credential_id)
            .ok_or(AuthRejection)?
            .clone();

        Ok(Authenticated(AuthContext::Remote {
            session,
            credential,
        }))
    }
}

/// The extractor is generic over `S: AppState`-like state. We also
/// provide a `State<AppState>` shim so handlers that want direct state
/// access can take both extractors in one signature — axum composes them
/// fine, and this keeps the boilerplate-for-the-reader low.
#[allow(dead_code)]
pub type AppStateExt = State<AppState>;
