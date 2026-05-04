//! End-to-end tests that the revocation broadcast channel fires
//! through the actual HTTP revoke routes — covers the wiring from
//! handler → `transact` → `AppState::revocations.emit()`.
//!
//! Transport-agnostic by design: these tests subscribe via
//! `AppState::subscribe_revocations()` as any future WS or WebRTC
//! handler would. Confirms the two revocation paths (direct device
//! revoke; indirect via setup-token revoke that cascades to a
//! paired credential) both publish the event.

mod common;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
};
use common::{ephemeral_state, json_body, req, seeded_auth, stub_credential};
use katulong_server::app;
use serde_json::json;
use std::time::{Duration, SystemTime};
use tokio::time::timeout;
use tower::util::ServiceExt;

#[tokio::test]
async fn direct_device_revoke_emits_broadcast() {
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, csrf) = seeded_auth(&state, "admin").await;
    // Seed a second credential so admin isn't the last one.
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("target")), ())))
        .await
        .unwrap();

    // Subscribe BEFORE the revoke fires — tokio::broadcast drops
    // events for which there are zero subscribers at emit time.
    let mut rx = state.subscribe_revocations();

    // Clone state so the test keeps a Sender handle alive after the
    // router (and its state clone) gets dropped at the end of
    // `oneshot`. Without this, the channel closes the instant the
    // router drops and `rx.recv()` returns `Closed`.
    let resp = app(state.clone())
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/credentials/target")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let event = timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("broadcast must fire within 500ms")
        .expect("receiver must get the event");
    assert_eq!(event.credential_id, "target");
}

#[tokio::test]
async fn device_revoke_on_unknown_id_does_not_emit() {
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, csrf) = seeded_auth(&state, "admin").await;
    // Second credential so admin isn't last.
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("other")), ())))
        .await
        .unwrap();

    let mut rx = state.subscribe_revocations();
    let resp = app(state.clone())
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/credentials/never-existed")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Unknown-id returns 404 post-cutover (was idempotent-204).
    // No emission either way — the assertion below proves that.
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // Unknown id → no state change → no emission. A short timeout
    // that MUST elapse without a message proves the negative.
    // `state` is still in scope (not moved into app), so the Sender
    // stays open and we get Elapsed from the timeout rather than
    // Closed from the channel.
    let result = timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(
        result.is_err(),
        "expected timeout (no broadcast) for unknown-id DELETE; got {:?}",
        result
    );
    // Keep state alive explicitly so the compiler doesn't decide
    // to drop it early.
    drop(state);
}

#[tokio::test]
async fn setup_token_revoke_emits_for_paired_credential() {
    // The indirect path: DELETE /api/tokens/:id cascades
    // to removing the paired credential. That cascade must also
    // publish the revocation broadcast — the credential is
    // functionally revoked from the consumer's point of view.
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, csrf) = seeded_auth(&state, "admin").await;
    let router = app(state.clone());

    // Mint a token via the HTTP API, then directly seed a paired
    // credential (we can't run a real WebAuthn pair in-process).
    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "phone" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let v = common::body_json(create).await;
    let token_id = v["id"].as_str().unwrap().to_string();

    let paired_cred_id = "phone-cred";
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

    let mut rx = state.subscribe_revocations();

    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let event = timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("broadcast must fire within 500ms for the cascade")
        .expect("receiver must get the cascade event");
    assert_eq!(event.credential_id, paired_cred_id);
}

#[tokio::test]
async fn setup_token_revoke_without_paired_credential_does_not_emit() {
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, csrf) = seeded_auth(&state, "admin").await;
    let router = app(state.clone());

    // Mint a token, don't pair it to any credential.
    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "unused" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let v = common::body_json(create).await;
    let token_id = v["id"].as_str().unwrap().to_string();

    let mut rx = state.subscribe_revocations();
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let result = timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(
        result.is_err(),
        "unused-token revoke must not broadcast — nothing to tear down"
    );
}
