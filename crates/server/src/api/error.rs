//! HTTP error shape for API handlers.
//!
//! One error type. Every handler returns `Result<Json<T>, ApiError>`
//! and this module owns the status-code + response-body mapping. The
//! response body is deliberately terse — a client gets a stable
//! `code` string and a short human-readable message, never stack
//! traces or server-side error chains. `AuthError`'s own `Display`
//! carries operator-facing context (paths, library detail) and is
//! suitable for server logs only; see the caller-obligation comment
//! in `crates/auth/src/error.rs`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use katulong_auth::AuthError;
use serde_json::json;

/// Every HTTP failure the auth routes can surface.
///
/// Variants here are named after the client-facing condition, not the
/// internal cause — an HTTP consumer should never need to understand
/// whether the failure was in serde, the mutex, or the filesystem.
/// Operator-facing detail (if any) is logged via `tracing` at the
/// `IntoResponse` site.
#[derive(Debug)]
pub enum ApiError {
    /// Caller is not authenticated (or session expired / unknown).
    Unauthorized,
    /// Caller is authenticated but not allowed to perform this action.
    /// Used for "first-device registration from non-localhost" etc.
    Forbidden(&'static str),
    /// Request body parse failure, missing field, bad format.
    BadRequest(&'static str),
    /// Challenge id in the finish request is unknown or expired.
    ChallengeNotFound,
    /// Server is rate-limiting pending ceremonies. Caller should retry.
    RateLimited,
    /// Nothing wrong with the request, but the state doesn't permit
    /// this action yet (e.g., login against a fresh install with no
    /// credentials).
    Conflict(&'static str),
    /// Anything else — mapped to 500. Internal detail goes to logs,
    /// NOT the response body.
    Internal(AuthError),
}

impl ApiError {
    fn as_pieces(&self) -> (StatusCode, &'static str, String) {
        match self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", "unauthorized".into()),
            Self::Forbidden(why) => (StatusCode::FORBIDDEN, "forbidden", (*why).into()),
            Self::BadRequest(why) => (StatusCode::BAD_REQUEST, "bad_request", (*why).into()),
            Self::ChallengeNotFound => (
                StatusCode::UNAUTHORIZED,
                "challenge_not_found",
                "challenge not found or expired".into(),
            ),
            Self::RateLimited => (
                StatusCode::SERVICE_UNAVAILABLE,
                "rate_limited",
                "server busy; retry shortly".into(),
            ),
            Self::Conflict(why) => (StatusCode::CONFLICT, "conflict", (*why).into()),
            Self::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error".into(),
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.as_pieces();
        // Log the full internal detail for operators — never reach the
        // client. `Display` of `AuthError` carries path + library chain.
        if let Self::Internal(ref inner) = self {
            tracing::error!(error = %inner, "api internal error");
        }
        let body = Json(json!({
            "error": { "code": code, "message": message },
        }));
        (status, body).into_response()
    }
}

impl From<AuthError> for ApiError {
    /// Best-effort classification of a raw `AuthError` into an HTTP shape.
    ///
    /// `ChallengeNotFound` and `TooManyPendingChallenges` have obvious
    /// HTTP semantics. `WebAuthn(_)` (runtime ceremony failure) maps to
    /// 401 — the assertion didn't verify, which from the caller's
    /// perspective looks like "auth failed." Everything else (IO,
    /// Parse of on-disk state, Hash, WebAuthnConfig — all
    /// server-internal) becomes 500.
    fn from(err: AuthError) -> Self {
        match err {
            AuthError::ChallengeNotFound => Self::ChallengeNotFound,
            AuthError::TooManyPendingChallenges => Self::RateLimited,
            AuthError::WebAuthn(_) => Self::Unauthorized,
            other => Self::Internal(other),
        }
    }
}
