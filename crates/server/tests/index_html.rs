//! Integration tests for the `/` SPA-shell handler — Phase 0a step 5
//! conditional CSRF meta-tag injection.
//!
//! The handler reads `index.html` from the configured trunk dist
//! directory. When the request carries a valid session cookie, it
//! injects `<meta name="csrf-token" content="...">` before the
//! first `</head>`. The frontend reads this meta on boot and
//! mirrors the token into `X-Csrf-Token` on every state-changing
//! fetch. Without a valid session cookie, the handler returns the
//! HTML untouched — the login page doesn't make CSRF-protected
//! calls (auth ceremonies are CSRF-exempt), so injecting nothing is
//! the right wire shape.
//!
//! Tests build their own `AppState` per case so each can point
//! `config.web_dist` at a tempdir-rooted scratch directory. This
//! avoids racing on a shared `KATULONG_WEB_DIST` env var across
//! cargo's parallel test threads.

mod common;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
};
use common::{cfg, req, seeded_auth};
use http_body_util::BodyExt;
use katulong_auth::{AuthStore, WebAuthnService};
use katulong_server::{
    app,
    state::{AppState, ServerConfig},
};
use std::path::PathBuf;
use tempfile::TempDir;
use tower::util::ServiceExt;

/// Build an `AppState` whose `web_dist` points at a tempdir
/// containing a stub `index.html`. Returns the state, the auth
/// tempdir, and the dist tempdir — the caller must keep all three
/// in scope for the duration of the test or the on-disk backing
/// store + dist files vanish.
async fn ephemeral_state_with_dist(html: &str) -> (AppState, TempDir, TempDir) {
    let auth_dir = TempDir::new().unwrap();
    let dist_dir = TempDir::new().unwrap();
    let dist_path: PathBuf = dist_dir.path().into();
    std::fs::write(dist_path.join("index.html"), html).unwrap();

    let store = AuthStore::open(auth_dir.path().join("auth.json"))
        .await
        .unwrap();
    let webauthn =
        WebAuthnService::new("katulong.test", "Katulong Test", "https://katulong.test").unwrap();
    let mut config: ServerConfig = cfg();
    config.web_dist = dist_path;
    let state = AppState::new(store, webauthn, config);
    (state, auth_dir, dist_dir)
}

/// Pull the response body as a UTF-8 string. `index.html` is
/// always text/html — never bytes that would fail UTF-8 conversion.
async fn body_string(resp: axum::response::Response) -> String {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

const STUB_HTML: &str = "<!DOCTYPE html><html><head><title>katulong</title></head><body></body></html>";

#[tokio::test]
async fn index_without_cookie_omits_csrf_meta() {
    // Login page case: the request carries no cookie, so there's
    // no session and no CSRF token to advertise. Returning the
    // bare HTML matches Node's behaviour at
    // `lib/routes/app-routes.js:251-260` — the meta tag only
    // appears once a session exists.
    let (state, _auth, _dist) = ephemeral_state_with_dist(STUB_HTML).await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.starts_with("text/html"),
        "index.html must be served as text/html, got {content_type}"
    );
    let body = body_string(resp).await;
    assert!(
        !body.contains("csrf-token"),
        "no session cookie → no csrf-token meta; got {body}"
    );
    assert!(body.contains("<title>katulong</title>"), "stub HTML present");
}

#[tokio::test]
async fn index_with_valid_cookie_injects_csrf_meta() {
    // Authenticated case: the meta tag carries the session's
    // paired CSRF token. The frontend reads
    // `meta[name="csrf-token"].content` to pick this up; the
    // exact attribute shape is part of the wire contract with
    // the JS frontend (`public/lib/api-client.js:9`).
    let (state, _auth, _dist) = ephemeral_state_with_dist(STUB_HTML).await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_string(resp).await;
    let expected = format!("<meta name=\"csrf-token\" content=\"{csrf}\">");
    assert!(
        body.contains(&expected),
        "csrf meta must be present with the session's paired token; body={body}"
    );
    // The injection lands inside the head, NOT in the body —
    // verify by checking the meta appears before the closing
    // body tag.
    let meta_idx = body.find("csrf-token").expect("meta present");
    let body_close_idx = body.find("</body>").expect("body close present");
    assert!(
        meta_idx < body_close_idx,
        "csrf meta must precede </body>"
    );
    let head_close_idx = body.find("</head>").expect("head close present");
    assert!(
        meta_idx < head_close_idx,
        "csrf meta must be inside <head>"
    );
}

#[tokio::test]
async fn index_with_unknown_cookie_omits_csrf_meta() {
    // Stale cookie: the client sends a token the server never
    // minted (or already pruned). No session lookup hits → no
    // injection, same as the no-cookie path. The frontend will
    // re-login and pick up a fresh token then.
    let (state, _auth, _dist) = ephemeral_state_with_dist(STUB_HTML).await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/")
                .header(
                    header::COOKIE,
                    "katulong_session=deadbeefdeadbeefdeadbeefdeadbeef",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_string(resp).await;
    assert!(
        !body.contains("csrf-token"),
        "unknown cookie must be treated as no cookie; got {body}"
    );
}
