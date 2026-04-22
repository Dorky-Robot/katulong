//! CSRF double-submit verification.
//!
//! State-changing routes require the caller to echo the session's
//! CSRF token in an `X-Csrf-Token` header. The header value is
//! constant-time compared to `Session.csrf_token` as stored at mint
//! time. Same-site Lax already blocks most cross-site forgeries from
//! other origins, but a same-site malicious script could still issue
//! credentialed POSTs — the CSRF double-submit closes that gap.
//!
//! The extractor is scoped to remote sessions: `AuthContext::Localhost`
//! bypasses the check because there's no session (and therefore no
//! paired CSRF token to compare against), which is consistent with
//! localhost's physical-access trust model.

use crate::api::error::ApiError;
use crate::auth_middleware::{AuthContext, Authenticated};
use crate::state::AppState;
use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderName},
};
use subtle::ConstantTimeEq;

/// Header the client must include on state-changing requests.
pub const CSRF_HEADER: HeaderName = HeaderName::from_static("x-csrf-token");

/// Successful CSRF validation, carrying the resolved `AuthContext` so
/// handlers don't need to re-extract `Authenticated`.
///
/// Usage: `async fn handler(CsrfProtected(ctx): CsrfProtected, ...)`.
/// The extractor runs `Authenticated` internally; if auth fails the
/// request gets 401, if CSRF fails 403 with code `csrf`.
pub struct CsrfProtected(pub AuthContext);

#[axum::async_trait]
impl FromRequestParts<AppState> for CsrfProtected {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Authenticated(ctx) = Authenticated::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::Unauthorized)?;

        // Localhost has no session and no CSRF pairing. Physical
        // access is the trust model; no further check adds security.
        if matches!(ctx, AuthContext::Localhost) {
            return Ok(Self(ctx));
        }

        let header = parts
            .headers
            .get(&CSRF_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(ApiError::CsrfMissing)?;

        let AuthContext::Remote { ref session, .. } = ctx else {
            unreachable!("non-Remote variant handled above");
        };
        if bool::from(header.as_bytes().ct_eq(session.csrf_token.as_bytes())) {
            Ok(Self(ctx))
        } else {
            Err(ApiError::CsrfMismatch)
        }
    }
}
