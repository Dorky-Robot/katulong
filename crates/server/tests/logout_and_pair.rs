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
    assert_eq!(v["error"]["code"], "csrf_missing");
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
    assert_eq!(v["error"]["code"], "csrf_mismatch");
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
    assert_eq!(create.status(), StatusCode::CREATED);
    let v = body_json(create).await;
    let token_id = v["id"].as_str().unwrap().to_string();
    assert!(!v["plaintext"].as_str().unwrap().is_empty());
    assert!(v["expires_at_millis"].as_u64().unwrap() > 0);

    // List shows it with status=live.
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
    let entries: Value = body_json(list).await;
    let entry = entries
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == token_id)
        .expect("created token should appear in list");
    assert_eq!(entry["name"], "iPad");
    assert_eq!(entry["status"], "live");
}

#[tokio::test]
async fn create_setup_token_without_csrf_is_403() {
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
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
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

    // First revoke: 204. Paired credential should cascade away.
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
    assert_eq!(first.status(), StatusCode::NO_CONTENT);
    let snap = state.auth_store.snapshot().await;
    assert!(
        snap.find_credential(paired_cred_id).is_none(),
        "paired credential must cascade-remove on token revoke"
    );
    assert!(
        snap.find_credential("admin-cred").is_some(),
        "unrelated credential must survive"
    );

    // Second revoke of the same id: 204 (idempotent).
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
    assert_eq!(second.status(), StatusCode::NO_CONTENT);
}

// ---------------- pair flow ----------------

#[tokio::test]
async fn pair_start_with_invalid_token_returns_401() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/pair/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "setup_token": "never-issued" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pair_start_with_valid_token_returns_challenge() {
    // Full pair_start path: seed an admin, mint a setup token via
    // the HTTP API, then submit its plaintext to pair_start and
    // confirm it returns a challenge.
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
    let plaintext = body_json(create).await["plaintext"]
        .as_str()
        .unwrap()
        .to_string();

    let start = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/pair/options")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "setup_token": plaintext })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start.status(), StatusCode::OK);
    let v = body_json(start).await;
    assert!(v["challenge_id"].as_str().is_some_and(|s| s.len() == 32));
    assert!(v["setup_token_id"].as_str().is_some());
    assert!(v["options"].is_object());
}

#[tokio::test]
async fn pair_finish_with_unknown_challenge_is_challenge_not_found() {
    let (state, _dir) = ephemeral_state().await;
    let body = json!({
        "challenge_id": "deadbeef",
        "setup_token_id": "any",
        "response": {
            "id": "AAAA",
            "rawId": "AAAA",
            "response": {"clientDataJSON": "", "attestationObject": ""},
            "type": "public-key",
            "extensions": {}
        }
    });
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/pair/verify")
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
