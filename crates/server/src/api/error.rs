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
    /// Caller is asking to remove a credential that is the last one on
    /// the instance, AND the caller is remote (not localhost). Allowing
    /// the deletion would lock the user out of their own installation
    /// over the tunnel — localhost access would still work, but
    /// re-enabling remote access would require going back to the
    /// first-device registration flow. Node hit this exact bug
    /// (`f25855f`); the two-tier access model means the guard must
    /// apply to remote callers only.
    LastCredential,
    /// State-changing request reached us without an `X-Csrf-Token`
    /// header. Maps to 403 with code `csrf_missing`. Distinct from
    /// `CsrfMismatch` so a client can distinguish "never sent" from
    /// "sent but wrong" — the first is a client-code bug, the second
    /// is an expired session.
    CsrfMissing,
    /// State-changing request reached us with an `X-Csrf-Token` that
    /// didn't match the session's paired value. Usually indicates a
    /// stale session (the client has a cookie + csrf from a previous
    /// login that's been superseded).
    CsrfMismatch,
    /// Anything else — mapped to 500. Internal detail is logged at the
    /// `From<AuthError>` conversion site, NOT stored on the variant, so
    /// no caller can pattern-match this variant and re-render the
    /// inner chain into user-facing text by accident. A future handler
    /// seeing `Internal` in a match arm sees only the tag.
    Internal,
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
            Self::LastCredential => (
                StatusCode::CONFLICT,
                "last_credential",
                "cannot remove the last remote-access credential from a non-localhost session".into(),
            ),
            Self::CsrfMissing => (
                StatusCode::FORBIDDEN,
                "csrf_missing",
                "missing X-Csrf-Token header".into(),
            ),
            Self::CsrfMismatch => (
                StatusCode::FORBIDDEN,
                "csrf_mismatch",
                "X-Csrf-Token does not match session".into(),
            ),
            Self::Internal => (
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
    /// perspective looks like "auth failed." `StateConflict` maps to
    /// 409 so a transact-internal invariant check surfaces the same
    /// shape as the handler's fast-fail guard. Everything else (IO,
    /// Parse of on-disk state, Hash, WebAuthnConfig — all
    /// server-internal) becomes 500 AND is logged here; the `Internal`
    /// variant deliberately carries no data so a future handler can't
    /// accidentally re-render the chain into a response body.
    fn from(err: AuthError) -> Self {
        match err {
            AuthError::ChallengeNotFound => Self::ChallengeNotFound,
            AuthError::TooManyPendingChallenges => Self::RateLimited,
            AuthError::WebAuthn(_) => Self::Unauthorized,
            AuthError::StateConflict(msg) => Self::Conflict(msg),
            other => {
                // Log the full chain for operators; the response body
                // stays opaque via the unit variant.
                tracing::error!(error = %other, "api internal error");
                Self::Internal
            }
        }
    }
}
