//! Integration tests for the auth HTTP routes.
//!
//! These cannot exercise a real WebAuthn ceremony without a real
//! authenticator on the other end — the crypto in `finish_*` requires
//! a browser-signed assertion, which an in-process test can't produce.
//! So the tests here cover:
//!
//! - `/auth/status` in all four cases (install × access)
//! - `register_start` guards: non-localhost → 403; fresh localhost → 200
//!   with a bare WebAuthn options object; already-initialised → 409
//! - `register_finish` guards: non-localhost → 403
//! - `register_finish` with a credential whose clientDataJSON challenge
//!   isn't in the pending map → 401 (Node-compatible flat error envelope)
//! - `register_finish` with a real challenge but cryptographically
//!   bogus response → 401 (exercises the crypto-reject path)
//! - `login_start` on a fresh install → 409 Conflict
//! - `login_finish` with unknown challenge → 401
//!
//! A separate end-to-end test that drives an actual browser passkey
//! belongs in the e2e layer (Playwright, slice 8-ish), not here.

mod common;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use common::{body_json, ephemeral_state, json_body, req, stub_credential};
use katulong_server::app;
use serde_json::{json, Value};
use tower::util::ServiceExt;

// ---------------- /auth/status ----------------

#[tokio::test]
async fn status_fresh_install_from_localhost() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::GET)
                .uri("/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    // Wire shape mirrors Node: `{setup, accessMethod}`. The
    // `authenticated` field is gone (Node never returned it);
    // the `accessMethod` key is camelCase on the wire.
    assert_eq!(v["accessMethod"], "localhost");
    assert_eq!(v["setup"], false);
    assert!(v.get("authenticated").is_none(), "no authenticated field on the wire");
    assert!(v.get("access_method").is_none(), "access_method renamed to accessMethod");
    assert!(v.get("has_credentials").is_none(), "has_credentials renamed to setup");
}

#[tokio::test]
async fn status_fresh_install_from_remote() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["accessMethod"], "remote");
    assert_eq!(v["setup"], false);
}

#[tokio::test]
async fn status_after_credential_registered() {
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(stub_credential("c1")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    assert_eq!(v["setup"], true);
}

// ---------------- /auth/register/options ----------------

#[tokio::test]
async fn register_start_from_remote_is_forbidden() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let v = body_json(resp).await;
    // Node-compatible flat envelope: `{"error": "<message>"}`.
    assert!(v["error"].is_string(), "error must be a flat string");
}

#[tokio::test]
async fn register_start_localhost_fresh_install_returns_challenge() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    // Bare `CreationChallengeResponse` at the top level — no
    // `challenge_id` envelope. Node returns `res.json(opts)`
    // and the JS frontend reads `opts.challenge`,
    // `opts.user.id`, etc., directly. Match that shape.
    assert!(
        v.get("challenge_id").is_none(),
        "no challenge_id wrapper field"
    );
    assert!(
        v.get("options").is_none(),
        "no options wrapper field — the options ARE the body"
    );
    assert!(
        v["publicKey"].is_object(),
        "body should be a CreationChallengeResponse with a publicKey field"
    );
    assert!(
        v["publicKey"]["challenge"].is_string(),
        "publicKey.challenge must be present at the top of the bare response"
    );
}

#[tokio::test]
async fn register_start_localhost_after_init_is_conflict() {
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(stub_credential("c1")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

// ---------------- /auth/register/verify ----------------

#[tokio::test]
async fn register_finish_from_remote_is_forbidden() {
    let (state, _dir) = ephemeral_state().await;
    let body = json!({
        "credential": fake_register_response_with_challenge("never-issued"),
    });
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/register/verify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn register_finish_with_unknown_challenge_returns_challenge_not_found() {
    // The credential's clientDataJSON references a challenge
    // that was never issued — pending map miss → 401.
    let (state, _dir) = ephemeral_state().await;
    let body = json!({
        "credential": fake_register_response_with_challenge("deadbeef-never-issued"),
    });
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/verify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn register_finish_with_real_challenge_but_bogus_response_returns_401() {
    // Covers the crypto-rejection path: a challenge was legitimately
    // issued by `register_start` so it exists in the pending map, but
    // the response payload is cryptographically garbage. webauthn-rs
    // must reject, `finish_registration` must return an error, and
    // the handler must map it to 401 `unauthorized` (not 500, not
    // `challenge_not_found`).
    let (state, _dir) = ephemeral_state().await;
    let router = app(state);

    let start = router
        .clone()
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    // Recover the issued challenge from the bare CCR — it
    // lives at `publicKey.challenge` (URL-safe-base64 string).
    // We echo it inside the credential's clientDataJSON so
    // the server's lookup hits the pending map; the bogus
    // attestationObject still trips webauthn-rs's verify.
    let issued_challenge = body_json(start).await["publicKey"]["challenge"]
        .as_str()
        .unwrap()
        .to_string();

    let body = json!({
        "credential": fake_register_response_with_challenge(&issued_challenge),
    });
    let resp = router
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/verify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn register_finish_with_bad_json_returns_400() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/register/verify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ---------------- /auth/login/options ----------------

#[tokio::test]
async fn login_start_on_fresh_install_is_conflict() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/login/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

// ---------------- /auth/login/verify ----------------

#[tokio::test]
async fn login_finish_with_unknown_challenge_returns_challenge_not_found() {
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .transact(|s| Ok((s.upsert_credential(stub_credential("c1")), ())))
        .await
        .unwrap();
    let body = json!({
        "credential": fake_login_response_with_challenge("deadbeef-never-issued"),
    });
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/login/verify")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

// Syntactically minimal WebAuthn response payloads. Not
// cryptographically valid — they exercise the challenge-lookup path
// without running real verification. Real crypto validation belongs
// in the browser-driven e2e tests.
//
// The cutover lifted the lookup key from a server-issued
// `challenge_id` to the credential's own
// `clientDataJSON.challenge`, so test fakes must embed a
// realistic clientDataJSON (base64url-encoded JSON with a
// `challenge` field) rather than an empty string.
fn fake_register_response_with_challenge(challenge_b64: &str) -> Value {
    let client_data = json!({
        "type": "webauthn.create",
        "challenge": challenge_b64,
        "origin": "https://katulong.test",
    });
    let cdj = URL_SAFE_NO_PAD.encode(client_data.to_string().as_bytes());
    json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "response": {"clientDataJSON": cdj, "attestationObject": ""},
        "type": "public-key",
        "extensions": {}
    })
}

fn fake_login_response_with_challenge(challenge_b64: &str) -> Value {
    let client_data = json!({
        "type": "webauthn.get",
        "challenge": challenge_b64,
        "origin": "https://katulong.test",
    });
    let cdj = URL_SAFE_NO_PAD.encode(client_data.to_string().as_bytes());
    json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "response": {
            "clientDataJSON": cdj,
            "authenticatorData": "",
            "signature": "",
            "userHandle": null
        },
        "type": "public-key",
        "extensions": {}
    })
}
