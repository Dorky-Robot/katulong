//! End-to-end auth middleware smoke test.
//!
//! Drives the router with in-process tower `ServiceExt::oneshot` calls
//! so we exercise the real axum extractor stack (including
//! `ConnectInfo`) without opening a socket. Each case exercises one
//! slice of `access.rs` / `auth_middleware.rs`:
//!
//! - unauthenticated remote request returns 401
//! - remote request with valid cookie returns 200 + credential id
//! - loopback peer + loopback host returns 200 with "localhost" access
//! - loopback peer + tunnel host returns 401 (the cloudflared scar)

use axum::{
    body::Body,
    http::{header, request::Builder as RequestBuilder, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use katulong_auth::{AuthStore, Credential, Session, WebAuthnService, SESSION_TTL};
use katulong_server::{
    app,
    state::{AppState, ServerConfig},
};
use std::net::SocketAddr;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;
use tower::util::ServiceExt;

fn cfg() -> ServerConfig {
    ServerConfig {
        public_origin: "https://katulong.test".into(),
        rp_id: "katulong.test".into(),
        rp_name: "Katulong Test".into(),
        cookie_secure: true,
    }
}

async fn build() -> (AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let store = AuthStore::open(dir.path().join("auth.json")).await.unwrap();
    let webauthn = WebAuthnService::new("katulong.test", "Katulong Test", "https://katulong.test")
        .unwrap();
    let state = AppState::new(store, webauthn, cfg());
    (state, dir)
}

fn cred(id: &str) -> Credential {
    Credential {
        id: id.into(),
        public_key: b"{}".to_vec(),
        name: None,
        counter: 0,
        created_at: SystemTime::UNIX_EPOCH,
        setup_token_id: None,
    }
}

/// Build a request with its ConnectInfo peer address pre-set via the
/// extension map so `ConnectInfo::<SocketAddr>::from_request_parts`
/// finds it. Without this, the extractor panics — `into_make_service_with_connect_info`
/// is what normally stamps this extension, and we bypass that when
/// calling the router directly via tower.
fn req(peer: SocketAddr, host: &str) -> RequestBuilder {
    Request::builder()
        .method(Method::GET)
        .extension(axum::extract::ConnectInfo(peer))
        .header(header::HOST, host)
}

#[tokio::test]
async fn unauthed_remote_request_is_rejected() {
    let (state, _dir) = build().await;
    let router = app(state);
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .uri("/api/me")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn remote_request_with_valid_cookie_is_authenticated() {
    let (state, _dir) = build().await;

    // Seed a credential + session directly into the store.
    let session_token;
    {
        let store = state.auth_store.clone();
        let token: String = store
            .transact(|s| {
                let credential = cred("c1");
                let now = SystemTime::now();
                let sess = Session::mint("c1", now, SESSION_TTL);
                let tok = sess.token.clone();
                let next = s.upsert_credential(credential).upsert_session(sess);
                Ok((next, tok))
            })
            .await
            .unwrap();
        session_token = token;
    }

    let router = app(state);
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .uri("/api/me")
                .header(
                    header::COOKIE,
                    format!("katulong_session={session_token}"),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["access"], "remote");
    assert_eq!(v["credential_id"], "c1");
}

#[tokio::test]
async fn loopback_peer_plus_loopback_host_bypasses_auth() {
    let (state, _dir) = build().await;
    let router = app(state);
    let resp = router
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .uri("/api/me")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["access"], "localhost");
    assert!(v["credential_id"].is_null());
}

#[tokio::test]
async fn loopback_peer_with_tunnel_host_is_remote_and_rejected() {
    // The Cloudflare Tunnel scar: cloudflared bridges from loopback, so
    // peer == 127.0.0.1 even for internet traffic. The Host header is
    // the public domain — must NOT classify as localhost.
    let (state, _dir) = build().await;
    let router = app(state);
    let resp = router
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "katulong.example.com")
                .uri("/api/me")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "loopback socket + tunnel host must not be classified as localhost"
    );
}

#[tokio::test]
async fn expired_session_cookie_is_rejected() {
    let (state, _dir) = build().await;
    let token: String = state
        .auth_store
        .transact(|s| {
            let credential = cred("c1");
            // Session created a long time ago and already expired.
            let expired_now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
            let sess = Session::mint("c1", expired_now, Duration::from_secs(60));
            let tok = sess.token.clone();
            let next = s.upsert_credential(credential).upsert_session(sess);
            Ok((next, tok))
        })
        .await
        .unwrap();

    let router = app(state);
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .uri("/api/me")
                .header(header::COOKIE, format!("katulong_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unauthed_routes_still_reachable() {
    let (state, _dir) = build().await;
    let router = app(state);
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}
