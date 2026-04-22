//! Integration tests for the auth HTTP routes.
//!
//! These cannot exercise a real WebAuthn ceremony without a real
//! authenticator on the other end — the crypto in `finish_*` requires
//! a browser-signed assertion, which an in-process test can't produce.
//! So the tests here cover:
//!
//! - `/api/auth/status` in all four cases (install × access)
//! - `register_start` guards: non-localhost → 403; fresh localhost → 200
//!   with a challenge id + options; already-initialised → 409
//! - `register_finish` guard: non-localhost → 403
//! - `register_finish` with a localhost peer but bogus challenge id →
//!   `challenge_not_found` (validates the error pipe, not the crypto)
//! - `login_start` on a fresh install → 409 (the Conflict branch that
//!   replaces Node's "empty usable credentials" 401)
//! - Unknown JSON shape → 400
//!
//! A separate end-to-end test that drives an actual browser passkey
//! belongs in the e2e layer (Playwright, slice 8-ish), not here.

use axum::{
    body::Body,
    http::{header, request::Builder as RequestBuilder, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use katulong_auth::{AuthStore, Credential, WebAuthnService};
use katulong_server::{
    app,
    state::{AppState, ServerConfig},
};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::SystemTime;
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

async fn ephemeral_state() -> (AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let store = AuthStore::open(dir.path().join("auth.json")).await.unwrap();
    let webauthn = WebAuthnService::new("katulong.test", "Katulong Test", "https://katulong.test")
        .unwrap();
    (AppState::new(store, webauthn, cfg()), dir)
}

fn seed_credential(id: &str) -> Credential {
    Credential {
        id: id.into(),
        public_key: b"{}".to_vec(),
        name: None,
        counter: 0,
        created_at: SystemTime::UNIX_EPOCH,
        setup_token_id: None,
    }
}

fn req(peer: SocketAddr, host: &str) -> RequestBuilder {
    Request::builder()
        .extension(axum::extract::ConnectInfo(peer))
        .header(header::HOST, host)
}

fn json_body<T: serde::Serialize>(value: &T) -> Body {
    Body::from(serde_json::to_vec(value).unwrap())
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

// ---------------- /api/auth/status ----------------

#[tokio::test]
async fn status_fresh_install_from_localhost() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::GET)
                .uri("/api/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["access_method"], "localhost");
    assert_eq!(v["has_credentials"], false);
    assert_eq!(v["authenticated"], true, "localhost is always authed");
}

#[tokio::test]
async fn status_fresh_install_from_remote() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["access_method"], "remote");
    assert_eq!(v["has_credentials"], false);
    assert_eq!(v["authenticated"], false, "no cookie + remote = unauthed");
}

#[tokio::test]
async fn status_after_credential_registered() {
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(seed_credential("c1")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    assert_eq!(v["has_credentials"], true);
    assert_eq!(v["authenticated"], false);
}

// ---------------- /api/auth/register/start ----------------

#[tokio::test]
async fn register_start_from_remote_is_forbidden() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/auth/register/start")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "forbidden");
}

#[tokio::test]
async fn register_start_localhost_fresh_install_returns_challenge() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/api/auth/register/start")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert!(
        v["challenge_id"].as_str().is_some_and(|s| s.len() == 32),
        "challenge_id should be 32 hex chars"
    );
    assert!(v["options"].is_object(), "options should be a JSON object");
}

#[tokio::test]
async fn register_start_localhost_after_init_is_conflict() {
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(seed_credential("c1")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/api/auth/register/start")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "conflict");
}

// ---------------- /api/auth/register/finish ----------------

#[tokio::test]
async fn register_finish_from_remote_is_forbidden() {
    let (state, _dir) = ephemeral_state().await;
    let body = json!({
        "challenge_id": "deadbeef",
        "response": fake_register_response(),
    });
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/auth/register/finish")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn register_finish_with_unknown_challenge_id_returns_challenge_not_found() {
    let (state, _dir) = ephemeral_state().await;
    let body = json!({
        "challenge_id": "deadbeef-never-issued",
        "response": fake_register_response(),
    });
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/api/auth/register/finish")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "challenge_not_found");
}

#[tokio::test]
async fn register_finish_with_bad_json_returns_400() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/api/auth/register/finish")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ---------------- /api/auth/login/start ----------------

#[tokio::test]
async fn login_start_on_fresh_install_is_conflict() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/auth/login/start")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "conflict");
}

// ---------------- /api/auth/login/finish ----------------

#[tokio::test]
async fn login_finish_with_unknown_challenge_id_returns_challenge_not_found() {
    let (state, _dir) = ephemeral_state().await;
    // Seed a credential so `login_start` wouldn't 409, though we bypass
    // it and go straight to finish with a bogus id.
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(seed_credential("c1")), ())))
        .await
        .unwrap();
    let body = json!({
        "challenge_id": "deadbeef",
        "response": fake_login_response(),
    });
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/auth/login/finish")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "challenge_not_found");
}

// Syntactically minimal WebAuthn response payloads. Not
// cryptographically valid — they exercise the challenge-lookup path
// without running real verification. Real crypto validation belongs
// in the browser-driven e2e tests.
fn fake_register_response() -> Value {
    json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "response": {"clientDataJSON": "", "attestationObject": ""},
        "type": "public-key",
        "extensions": {}
    })
}

fn fake_login_response() -> Value {
    json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "response": {
            "clientDataJSON": "",
            "authenticatorData": "",
            "signature": "",
            "userHandle": null
        },
        "type": "public-key",
        "extensions": {}
    })
}
