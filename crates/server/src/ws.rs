//! WebSocket upgrade endpoint.
//!
//! This slice wires the transport only — authenticated upgrade,
//! Origin validation, and a minimal accept-and-close loop that
//! handles `Ping`/`Pong`/`Close`. No terminal I/O yet; slice 9 will
//! replace the loop with tmux/PTY wiring.
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
use crate::state::AppState;
use crate::transport::{
    websocket::into_transport, ClientMessage, ServerMessage, TransportHandle, PROTOCOL_VERSION,
};
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

/// Render an attacker-controlled string (like a rejected Origin
/// value) safe for `tracing` emission: strip ASCII control
/// characters that would corrupt text logs or inject structured
/// fields in JSON formatters, cap at 256 chars. Used only at reject
/// sites; the accept path never logs the Origin.
fn sanitize_for_log(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_ascii_control())
        .take(256)
        .collect()
}

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
    Authenticated(_ctx): Authenticated,
    upgrade: Option<WebSocketUpgrade>,
) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let access = AccessMethod::classify(peer, host);
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());

    match validate_origin(access, origin, &state.config.public_origin) {
        OriginCheck::LocalhostExempt | OriginCheck::Allowed => match upgrade {
            Some(u) => {
                // Capture state here so slice 9d can thread it
                // into `serve_session` as a body change, not a
                // call-site + signature rework. The auth
                // `AuthContext` would also be captured here in
                // 9d — the extractor's lifetime ends when the
                // handler returns, and the terminal layer needs
                // credential id for revocation matching.
                let state_for_session = state.clone();
                u.on_upgrade(|ws: WebSocket| async move {
                    // Hand the raw socket to the transport adapter
                    // immediately; from here on the consumer sees
                    // only the abstraction. A future WebRTC
                    // upgrade path would swap in a different
                    // adapter without this handler changing.
                    // `_pumps` is intentionally ignored — both
                    // tasks observe channel closure and exit
                    // cleanly when serve_session drops the handle.
                    let (handle, _pumps) = into_transport(ws);
                    serve_session(state_for_session, handle).await;
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
            let safe = sanitize_for_log(origin.unwrap_or(""));
            tracing::warn!(
                origin = %safe,
                expected = %state.config.public_origin,
                "ws upgrade rejected: Origin mismatch"
            );
            (StatusCode::FORBIDDEN, "origin not allowed").into_response()
        }
    }
}

/// Per-connection consumer loop.
///
/// The WS frame plumbing lives in `transport::websocket`; this
/// function consumes the resulting `TransportHandle`. By design it
/// does NOT import `axum::ws` types — when the WebRTC transport
/// slice lands, the same loop runs unchanged against a
/// `TransportHandle` whose pumps speak DataChannel.
///
/// `state` is threaded through for slice 9d's use (session manager
/// access, revocation subscription). Slice 9c ignores it aside from
/// holding the handle alive, but the parameter exists now so 9d is
/// a body-only change rather than also reworking the call site.
///
/// # SECURITY (slice-9d obligation)
///
/// This loop does NOT yet subscribe to
/// `state.subscribe_revocations()`. An active connection whose
/// bound credential is revoked between `Authenticated` extractor
/// and now will continue streaming until the client disconnects.
/// Slice 9d MUST wire the revocation channel via a
/// `tokio::select!` between `handle.inbound.recv()` and the
/// revocation receiver; on a matching credential id, close the
/// transport via `handle.outbound` drop. Until then, an attacker
/// who has captured a session cookie cannot be evicted in
/// real time — only the next auth-required HTTP request will see
/// the cascade.
///
/// Slice-9c behavior (placeholder until slice 9d wires the terminal):
/// - Send `Hello` immediately so the client sees the connection is
///   alive + knows the protocol version.
/// - Respond to app-level `Ping { nonce }` with `Pong { nonce }`.
/// - Exit cleanly on peer disconnect (`inbound` channel closes).
/// - Log-and-continue on decode errors — the transport stays open;
///   a single malformed frame from a glitchy client doesn't
///   terminate the whole session. The Node scar `9dc7c78` said
///   validate at the boundary; the typed deserialization already
///   fails closed, this layer just reports it.
async fn serve_session(_state: AppState, handle: TransportHandle) {
    let mut handle = handle;
    if handle
        .send(ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION.to_string(),
        })
        .await
        .is_err()
    {
        // Transport closed before we could even send hello. Bail.
        return;
    }
    while let Some(msg) = handle.inbound.recv().await {
        match msg {
            Ok(ClientMessage::Ping { nonce }) => {
                if handle.send(ServerMessage::Pong { nonce }).await.is_err() {
                    break;
                }
            }
            Err(err) => {
                // Decoder/frame error. Log the operator-visible
                // detail but keep the connection — a single bad
                // frame isn't a reason to kick the user out.
                tracing::warn!(error = %err, "transport frame error; dropping");
            }
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
    fn sanitize_for_log_strips_control_chars_and_caps_length() {
        assert_eq!(
            sanitize_for_log("evil\r\n[WARN] faked=line"),
            "evil[WARN] faked=line",
            "newlines and carriage returns must be stripped — otherwise a crafted Origin can forge log lines"
        );
        assert_eq!(sanitize_for_log("plain"), "plain");
        let huge = "x".repeat(1000);
        assert_eq!(
            sanitize_for_log(&huge).len(),
            256,
            "cap at 256 chars so an attacker can't flood logs with a megabyte Origin"
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
