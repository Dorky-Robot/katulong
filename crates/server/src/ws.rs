//! WebSocket upgrade endpoint.
//!
//! This module is the HTTP-level entry point: authenticate the
//! request, validate the Origin, and if both pass, upgrade to a
//! WebSocket and hand the resulting `TransportHandle` to
//! `session::handler::serve_session`. No terminal I/O lives here —
//! the session handler owns the consumer loop against the
//! transport abstraction, which keeps this file transport-specific
//! (axum `WebSocketUpgrade`) and the session layer transport-
//! agnostic.
//!
//! # Security-critical: Origin validation
//!
//! A WebSocket upgrade from `https://evil.com` running in the victim's
//! browser will arrive at katulong carrying the victim's session
//! cookie (SameSite=Lax allows top-level navigations and CORS-free
//! WebSocket handshakes). Without an Origin check, the attacker's
//! page gets an authenticated terminal socket — CSWSH, full shell.
//!
//! The Node implementation learned this in two stages:
//! - `dd5d88f`: require Origin on non-local connections. Missing
//!   Origin is not "benign non-browser client," it's "attacker
//!   controls a non-browser agent with the victim's cookie." Deny by
//!   default; exempt only truly-loopback peers.
//! - `8fb2663`: run Origin validation BEFORE any routing branching
//!   so every path is covered. Here that's structural: `ws_handler`
//!   is the single upgrade endpoint and checks Origin before calling
//!   `ws.on_upgrade`.
//!
//! Origin must match the operator-configured `public_origin` exactly
//! (scheme + host + optional port). We do not accept "any Origin that
//! resolves to a loopback" or "any Origin matching the Host header" —
//! the configured origin is the single authority.

use crate::access::AccessMethod;
use crate::auth_middleware::Authenticated;
use crate::log_util::sanitize_for_log;
use crate::session::serve_session;
use crate::state::AppState;
use crate::transport::websocket::into_transport;
use axum::{
    extract::{ws::WebSocket, ConnectInfo, State, WebSocketUpgrade},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

/// Strict Origin check result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OriginCheck {
    /// Request is from a genuinely-local peer; Origin is not required.
    /// Matches the loopback-socket + loopback-Host gate in
    /// `AccessMethod::Localhost`.
    LocalhostExempt,
    /// Origin header present and matches configured `public_origin`
    /// byte-for-byte.
    Allowed,
    /// No Origin header on a non-local connection. Deny-by-default
    /// (Node `dd5d88f` scar — validate-if-present was the gap).
    Missing,
    /// Origin present but disagrees with configured value.
    Mismatch,
}

/// Decide whether a WebSocket upgrade is allowed to proceed.
///
/// Takes the request's peer/Host-derived `AccessMethod` (already
/// computed by the caller for auth), the `Origin` header value, and
/// the operator-supplied `public_origin`. Returns one of four
/// classifications the caller maps to HTTP status codes. Pure —
/// unit-testable without a real HTTP stack.
pub(crate) fn validate_origin(
    access: AccessMethod,
    origin: Option<&str>,
    public_origin: &str,
) -> OriginCheck {
    if matches!(access, AccessMethod::Localhost) {
        return OriginCheck::LocalhostExempt;
    }
    match origin {
        None => OriginCheck::Missing,
        Some(value) if value == public_origin => OriginCheck::Allowed,
        Some(_) => OriginCheck::Mismatch,
    }
}

/// Cap on Origin values emitted to logs at reject sites. Longer
/// than the 32-char cap on protocol-version strings because an
/// operator diagnosing a legitimate Origin mismatch benefits from
/// seeing most of the full URL. Shared sanitizer lives in
/// `crate::log_util`.
const LOG_ORIGIN_MAX_LEN: usize = 256;

/// Axum handler for `GET /ws`.
///
/// Origin + auth validation run BEFORE the WebSocket upgrade
/// extractor is consulted — Node scar `8fb2663` says security checks
/// must be earliest in the pipeline, before any branching. We take
/// `Option<WebSocketUpgrade>` so the upgrade extractor never rejects
/// the request on its own; our handler body decides what happens.
/// If origin/auth fails we return 401/403; if they pass and the
/// upgrade extractor is `None` (missing WS headers), we return the
/// upgrade-required error our own way.
pub async fn ws_handler(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Authenticated(ctx): Authenticated,
    upgrade: Option<WebSocketUpgrade>,
) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());

    // Capture the credential id BEFORE consuming `ctx` into the
    // closure below. `AuthContext::Localhost` returns None here,
    // which the session handler interprets as "can't be revoked" —
    // matches the auth model where localhost requests bypass the
    // credential gate entirely.
    let credential_id = ctx.credential_id().map(|s| s.to_string());

    match validate_origin(access, origin, &state.config.public_origin) {
        OriginCheck::LocalhostExempt | OriginCheck::Allowed => match upgrade {
            Some(u) => {
                let state_for_session = state.clone();
                u.on_upgrade(move |ws: WebSocket| async move {
                    // Hand the raw socket to the transport adapter
                    // immediately; from here on the consumer sees
                    // only the abstraction. A future WebRTC
                    // upgrade path would swap in a different
                    // adapter without this handler changing.
                    // `_pumps` is intentionally ignored — both
                    // tasks observe channel closure and exit
                    // cleanly when serve_session drops the handle.
                    let (handle, _pumps) = into_transport(ws);
                    serve_session(state_for_session, handle, credential_id).await;
                })
            }
            None => (
                StatusCode::UPGRADE_REQUIRED,
                "websocket upgrade headers required",
            )
                .into_response(),
        },
        OriginCheck::Missing => {
            tracing::warn!("ws upgrade rejected: missing Origin on non-local connection");
            (StatusCode::FORBIDDEN, "origin header required").into_response()
        }
        OriginCheck::Mismatch => {
            // The Origin value is attacker-controlled; sanitize
            // before logging so control characters can't corrupt
            // text log lines or inject structured-field separators
            // in JSON formatters.
            let safe = sanitize_for_log(origin.unwrap_or(""), LOG_ORIGIN_MAX_LEN);
            tracing::warn!(
                origin = %safe,
                expected = %state.config.public_origin,
                "ws upgrade rejected: Origin mismatch"
            );
            (StatusCode::FORBIDDEN, "origin not allowed").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC: &str = "https://katulong.test";

    #[test]
    fn localhost_is_exempt_from_origin_check() {
        assert_eq!(
            validate_origin(AccessMethod::Localhost, None, PUBLIC),
            OriginCheck::LocalhostExempt
        );
        assert_eq!(
            validate_origin(AccessMethod::Localhost, Some("https://elsewhere.invalid"), PUBLIC),
            OriginCheck::LocalhostExempt,
            "localhost peers are exempt even if Origin is set to a wrong value"
        );
    }

    #[test]
    fn remote_without_origin_is_missing() {
        assert_eq!(
            validate_origin(AccessMethod::Remote, None, PUBLIC),
            OriginCheck::Missing
        );
    }

    #[test]
    fn remote_with_matching_origin_is_allowed() {
        assert_eq!(
            validate_origin(AccessMethod::Remote, Some(PUBLIC), PUBLIC),
            OriginCheck::Allowed
        );
    }

    #[test]
    fn remote_with_mismatched_origin_is_rejected() {
        assert_eq!(
            validate_origin(AccessMethod::Remote, Some("https://evil.example"), PUBLIC),
            OriginCheck::Mismatch
        );
        assert_eq!(
            validate_origin(AccessMethod::Remote, Some(""), PUBLIC),
            OriginCheck::Mismatch,
            "empty Origin is a real value, not missing"
        );
    }

    #[test]
    fn trailing_slash_differences_mismatch() {
        // Byte-for-byte match: no canonicalization, no scheme
        // relaxation. Operator's configured value IS the source of
        // truth; any deviation is a reject.
        assert_eq!(
            validate_origin(
                AccessMethod::Remote,
                Some("https://katulong.test/"),
                PUBLIC
            ),
            OriginCheck::Mismatch
        );
    }
}
