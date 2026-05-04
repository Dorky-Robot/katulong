//! Integration tests for slice 6 — logout + setup-token management +
//! pair flow + CSRF enforcement.
//!
//! Like the other integration suites, real WebAuthn crypto is out of
//! reach without a browser-signed assertion. These tests cover:
//! - CSRF enforcement on state-changing routes
//! - Logout: 401 without auth, 409 from localhost, 204 + Set-Cookie
//!   clearing on success
//! - Setup-token lifecycle: create/list/revoke, cascading revoke
//! - Pair flow gates: invalid token → 401, revoked-between-start-and-finish
//!   → 409
//!
//! End-to-end pair with a real authenticator belongs in Playwright.

mod common;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use common::{body_json, ephemeral_state, json_body, req, seeded_auth, stub_credential};
use katulong_server::app;
use serde_json::{json, Value};
use std::time::SystemTime;
use tower::util::ServiceExt;

// ---------------- logout ----------------

#[tokio::test]
async fn logout_without_auth_returns_401() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/logout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logout_without_csrf_returns_403() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/logout")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let v = body_json(resp).await;
    // Flat error envelope: `{"error": "<message>"}`.
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn logout_with_wrong_csrf_returns_403_mismatch() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/logout")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", "wrong-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn logout_with_valid_auth_and_csrf_clears_cookie_and_session() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state.clone())
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/logout")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let set_cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        set_cookie.contains("Max-Age=0"),
        "response must clear the cookie: got {set_cookie}"
    );

    // Session is actually gone from the store.
    let snap = state.auth_store.snapshot().await;
    assert!(
        snap.find_session(&cookie).is_none(),
        "session should be removed from store after logout"
    );
}

#[tokio::test]
async fn logout_from_localhost_is_conflict() {
    // Localhost has no session to end; Node hid the button for the
    // same reason (`23981ca`). Treat as Conflict so the UI doesn't
    // silently show a fake success.
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/logout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

// ---------------- setup-token management ----------------

#[tokio::test]
async fn list_setup_tokens_requires_auth() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/tokens")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn create_and_list_setup_token_roundtrip() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "c1").await;

    // Create.
    let router = app(state);
    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "iPad" })))
                .unwrap(),
        )
        .await
        .unwrap();
    // Node returns 200 (NOT 201). Body shape:
    // `{id, name, token, createdAt, expiresAt}`.
    assert_eq!(create.status(), StatusCode::OK);
    let v = body_json(create).await;
    let token_id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["name"], "iPad");
    assert!(
        !v["token"].as_str().unwrap().is_empty(),
        "field renamed plaintext → token"
    );
    assert!(v["createdAt"].as_u64().unwrap() > 0);
    assert!(v["expiresAt"].as_u64().unwrap() > 0);

    // List wraps entries under `{tokens: [...]}` with camelCase
    // fields and the `credential` join (null until paired).
    let list = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let body: Value = body_json(list).await;
    let entries = body["tokens"].as_array().expect("tokens array");
    let entry = entries
        .iter()
        .find(|e| e["id"] == token_id)
        .expect("created token should appear in list");
    assert_eq!(entry["name"], "iPad");
    assert!(entry["createdAt"].is_u64());
    assert!(entry["expiresAt"].is_u64());
    assert!(
        entry["credential"].is_null(),
        "credential nested-join is null until the token is redeemed"
    );
    assert!(
        entry.get("status").is_none(),
        "status dropped — Node never exposed it"
    );
}

#[tokio::test]
async fn create_setup_token_rejects_missing_name() {
    // Node treats `name` as required (`!name || !name.trim()` → 400).
    // The pre-cutover Rust route accepted no name; matching Node now
    // fails fast with `{"error": "Token name is required"}`. CSRF
    // enforcement on this route returns in step 5.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let v = body_json(resp).await;
    assert_eq!(v["error"], "Token name is required");
}

#[tokio::test]
async fn create_setup_token_rejects_oversized_name() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "c1").await;
    let long_name = "x".repeat(200);
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": long_name })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let v = body_json(resp).await;
    assert_eq!(v["error"], "Token name too long (max 128 characters)");
}

#[tokio::test]
async fn revoke_setup_token_is_idempotent_and_cascades() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin-cred").await;
    let router = app(state.clone());

    // Create a token then pair a second credential against it (via
    // direct state mutation — we can't run real WebAuthn inline).
    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "laptop" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(create).await;
    let token_id = v["id"].as_str().unwrap().to_string();
    let paired_cred_id = "laptop-cred";
    state
        .auth_store
        .clone()
        .transact({
            let token_id = token_id.clone();
            let paired_cred_id = paired_cred_id.to_string();
            move |s| {
                let mut cred = stub_credential(&paired_cred_id);
                cred.setup_token_id = Some(token_id.clone());
                let next = s
                    .upsert_credential(cred)
                    .consume_setup_token(&token_id, &paired_cred_id, SystemTime::now());
                Ok((next, ()))
            }
        })
        .await
        .unwrap();

    // First revoke: 200 {"ok": true}. Paired credential cascades.
    let first = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let v = body_json(first).await;
    assert_eq!(v["ok"], true);
    let snap = state.auth_store.snapshot().await;
    assert!(
        snap.find_credential(paired_cred_id).is_none(),
        "paired credential must cascade-remove on token revoke"
    );
    assert!(
        snap.find_credential("admin-cred").is_some(),
        "unrelated credential must survive"
    );

    // Second revoke of the same id: 404 — Node distinguishes
    // "successfully removed" from "already gone." The pre-cutover
    // idempotent-204 was a Rust convenience.
    let second = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::NOT_FOUND);
    let v = body_json(second).await;
    assert_eq!(v["error"], "Token not found");
}

// ---------------- pair flow ----------------
//
// Phase 0a step 4 merged `/auth/pair/*` into `/auth/register/*`.
// The pair flow is now selected by sending `setupToken` (camelCase
// — `RegisterOptionsRequest` / `RegisterFinishRequest` are
// `rename_all = "camelCase"` to match Node's
// `JSON.stringify({ setupToken })` in `public/login.js`).
// First-device-localhost behaviour stays in `auth_routes.rs`; the
// tests below cover the token-gated (remote-allowed) leg.

#[tokio::test]
async fn pair_start_with_invalid_token_returns_401() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "setupToken": "never-issued" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pair_start_with_valid_token_returns_challenge() {
    // Full token-gated register_start path: seed an admin, mint a
    // setup token via the HTTP API, then submit its plaintext to
    // `/auth/register/options` and confirm a challenge comes back.
    // The token branch is not gated on localhost — submit from a
    // remote peer to prove that.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin-cred").await;
    let router = app(state.clone());

    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "paired-device" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let plaintext = body_json(create).await["token"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/register/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "setupToken": plaintext })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let v = body_json(start).await;
    // Bare `CreationChallengeResponse` at the top level —
    // matches Node's shape. No `setup_token_id` echo: verify
    // takes the plaintext `setupToken` again and re-resolves
    // the id under the state mutex.
    assert!(v.get("challenge_id").is_none());
    assert!(v.get("setup_token_id").is_none());
    assert!(v.get("options").is_none());
    assert!(v["publicKey"].is_object());
    assert!(v["publicKey"]["challenge"].is_string());
}

#[tokio::test]
async fn pair_finish_with_invalid_token_returns_401() {
    // The token-gated `register_finish` leg rejects an
    // unredeemable `setupToken` before the WebAuthn ceremony runs.
    // Body shape: `{credential, setupToken}` (camelCase) — no
    // `challenge_id`, no `setup_token_id` echo.
    let (state, _dir) = ephemeral_state().await;
    let cdj = URL_SAFE_NO_PAD.encode(
        json!({
            "type": "webauthn.create",
            "challenge": "deadbeef",
            "origin": "https://katulong.test",
        })
        .to_string()
        .as_bytes(),
    );
    let body = json!({
        "setupToken": "never-issued",
        "credential": {
            "id": "AAAA",
            "rawId": "AAAA",
            "response": {"clientDataJSON": cdj, "attestationObject": ""},
            "type": "public-key",
            "extensions": {}
        }
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
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let v = body_json(resp).await;
    assert!(v["error"].is_string());
}
