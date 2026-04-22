//! Integration tests for `/ws` upgrade.
//!
//! These cover the HTTP-level reject paths (auth + Origin) before
//! the upgrade handshake happens. A real 101 Switching Protocols
//! response needs a listening socket and a WS client — deferred to
//! e2e. What oneshot can reach: when the request carries valid WS
//! upgrade headers, the handler body runs; we verify auth and origin
//! checks return 401/403 before any protocol switch.
//!
//! The tests include the full WebSocket upgrade header set
//! (`Upgrade`, `Connection`, `Sec-WebSocket-Key`,
//! `Sec-WebSocket-Version`) because axum's `WebSocketUpgrade`
//! extractor fails with 400 if those are missing — that would never
//! reach the handler body, so origin rejection wouldn't be observed.
//! A real CSWSH attack always includes these headers anyway (the
//! attacker's JS creates a real WebSocket), so this is the realistic
//! test shape.

mod common;

use axum::{
    body::Body,
    http::{header, request::Builder as RequestBuilder, Method, StatusCode},
};
use common::{ephemeral_state, req, seeded_auth};
use katulong_server::app;
use tower::util::ServiceExt;

/// Tack the minimum WS-upgrade headers onto a request builder.
fn ws_upgrade(builder: RequestBuilder) -> RequestBuilder {
    builder
        .method(Method::GET)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "upgrade")
        // Any valid base64-encoded 16-byte value works for the handshake.
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("sec-websocket-version", "13")
}

#[tokio::test]
async fn ws_without_auth_returns_401() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            ws_upgrade(req("203.0.113.5:1234".parse().unwrap(), "katulong.test"))
                .uri("/ws")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ws_from_remote_without_origin_is_forbidden() {
    // Authenticated + WS-upgrade headers present but no Origin on a
    // non-local connection. Node `dd5d88f` scar — missing Origin is
    // not "benign non-browser client," it's "attacker with the
    // victim's cookie." Deny-by-default.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            ws_upgrade(req("203.0.113.5:1234".parse().unwrap(), "katulong.test"))
                .uri("/ws")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ws_from_remote_with_mismatched_origin_is_forbidden() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            ws_upgrade(req("203.0.113.5:1234".parse().unwrap(), "katulong.test"))
                .uri("/ws")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header(header::ORIGIN, "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ws_plain_get_without_upgrade_headers_fails_fast() {
    // The WebSocketUpgrade extractor fails with 400 when WS headers
    // are absent. We don't assert the exact status — just that the
    // request rejects cleanly rather than silently succeeding. This
    // covers the "plain HTTP probe on /ws" case.
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::GET)
                .uri("/ws")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        resp.status().is_client_error(),
        "expected 4xx for missing upgrade headers; got {}",
        resp.status()
    );
}
