//! Integration tests for `/api/credentials`.
//!
//! Covers listing, CSRF-deferred behaviour (CSRF lands in step 5),
//! revoke cascade to sessions, the 404-on-unknown-id response shape,
//! and the last-credential guard (remote callers → 403; localhost
//! bypasses it). Wire shape mirrors Node — list returns `{credentials:
//! [...]}`, revoke returns `200 {"ok": true}`, last-credential guard
//! returns 403 with the literal Node message.

mod common;

use axum::{
    body::Body,
    http::{header, Method, StatusCode},
};
use common::{body_json, ephemeral_state, req, seeded_auth, stub_credential};
use katulong_server::app;
use serde_json::Value;
use tower::util::ServiceExt;

// ---------------- list ----------------

#[tokio::test]
async fn list_devices_requires_auth() {
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/credentials")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_devices_returns_node_shape() {
    // Wrapped object `{credentials: [...]}` with camelCase fields:
    // `id`, `name`, `createdAt`, `lastUsedAt`, `userAgent`,
    // `setupTokenId`. The pre-cutover bare-array shape is gone.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "my-device").await;

    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/credentials")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    let entries = v["credentials"].as_array().expect("credentials array");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["id"], "my-device");
    assert!(entry["name"].is_string(), "name present (empty allowed)");
    assert!(entry["createdAt"].is_u64(), "camelCase createdAt");
    assert!(
        entry["lastUsedAt"].is_null() || entry["lastUsedAt"].is_u64(),
        "lastUsedAt is null or unix-millis"
    );
    assert!(entry["userAgent"].is_string());
    assert!(
        entry.get("counter").is_none(),
        "counter must NOT appear (Node never exposed it)"
    );
    assert!(
        entry.get("is_current").is_none() && entry.get("isCurrent").is_none(),
        "is_current dropped — frontend doesn't read it"
    );
}

#[tokio::test]
async fn list_devices_surfaces_setup_token_id() {
    // Bidirectional link: `Credential.setup_token_id` surfaces under
    // camelCase `setupTokenId` to match Node.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "admin").await;
    state
        .auth_store
        .clone()
        .transact(|s| {
            let mut cred = stub_credential("paired-device");
            cred.setup_token_id = Some("token-abc".into());
            Ok((s.upsert_credential(cred), ()))
        })
        .await
        .unwrap();

    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/credentials")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    let paired = v["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "paired-device")
        .expect("paired device should appear in list");
    assert_eq!(paired["setupTokenId"], "token-abc");
}

// ---------------- revoke ----------------

#[tokio::test]
async fn revoke_device_returns_200_ok_envelope() {
    // Node returns `200 {"ok": true}`; the pre-cutover Rust 204 is
    // gone. Keeps the JS frontend's `data.ok` check honest.
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, _csrf) = seeded_auth(&state, "admin").await;
    let (target_cookie, _target_csrf) = seeded_auth(&state, "target-device").await;

    let router = app(state.clone());
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/credentials/target-device")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["ok"], true);

    let snap = state.auth_store.snapshot().await;
    assert!(
        snap.find_credential("target-device").is_none(),
        "target credential must be gone"
    );
    assert!(
        snap.find_session(&target_cookie).is_none(),
        "target credential's session must cascade away"
    );
    assert!(
        snap.find_credential("admin").is_some(),
        "admin credential must survive"
    );
}

#[tokio::test]
async fn revoke_device_unknown_id_is_404() {
    // Node 404s on unknown id (`{"error": "Credential not found"}`).
    // The pre-cutover Rust path was idempotent-204; matching Node
    // means the frontend can distinguish "already gone" from
    // "successfully removed."
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "admin").await;
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("other")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/credentials/never-existed")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let v: Value = body_json(resp).await;
    assert_eq!(v["error"], "Credential not found");
}

#[tokio::test]
async fn revoke_last_credential_from_remote_is_403_with_literal_message() {
    // Single credential + remote caller. Last-credential guard fires
    // → 403 with the literal Node message ("Cannot remove the last
    // credential — would lock you out"). The frontend renders
    // `err.error` verbatim, so the wording is part of the wire.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "only-device").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/credentials/only-device")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let v = body_json(resp).await;
    assert_eq!(
        v["error"],
        "Cannot remove the last credential — would lock you out"
    );
}

#[tokio::test]
async fn revoke_last_credential_from_localhost_is_allowed() {
    // Localhost bypasses the guard — physical access trumps lockout
    // concern (Node scar f25855f).
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("only-device")), ())))
        .await
        .unwrap();
    let resp = app(state.clone())
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::DELETE)
                .uri("/api/credentials/only-device")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["ok"], true);
    let snap = state.auth_store.snapshot().await;
    assert!(snap.credentials.is_empty());
}
