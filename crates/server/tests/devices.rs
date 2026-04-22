//! Integration tests for `/api/auth/devices`.
//!
//! Covers listing, current-device marking, CSRF enforcement, revoke
//! cascade to sessions, idempotent delete, and the last-credential
//! guard (remote-only; localhost bypasses it).

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
                .uri("/api/auth/devices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_devices_returns_is_current_for_remote_caller() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "my-device").await;
    // Seed another device so we can verify ONLY one row has is_current=true.
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("other-device")), ())))
        .await
        .unwrap();

    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/auth/devices")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    let entries = v.as_array().expect("array response");
    assert_eq!(entries.len(), 2);

    let current: Vec<&Value> = entries
        .iter()
        .filter(|e| e["is_current"].as_bool() == Some(true))
        .collect();
    assert_eq!(current.len(), 1, "exactly one entry should be current");
    assert_eq!(current[0]["id"], "my-device");
}

#[tokio::test]
async fn list_devices_from_localhost_shows_no_current() {
    // Localhost has no paired credential — every entry reports is_current=false.
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("c1")), ())))
        .await
        .unwrap();

    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::GET)
                .uri("/api/auth/devices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["is_current"], false);
}

#[tokio::test]
async fn list_devices_surfaces_setup_token_id() {
    // Bidirectional link: Credential.setup_token_id surfaces on the
    // DTO under the same field name. Set it directly via state
    // mutation since we can't run a real pair ceremony inline.
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
                .uri("/api/auth/devices")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v = body_json(resp).await;
    let paired = v
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "paired-device")
        .expect("paired device should appear in list");
    assert_eq!(paired["setup_token_id"], "token-abc");
}

// ---------------- revoke ----------------

#[tokio::test]
async fn revoke_device_requires_csrf() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "c1").await;
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
                .uri("/api/auth/devices/other")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoke_device_cascades_to_sessions() {
    let (state, _dir) = ephemeral_state().await;
    let (admin_cookie, csrf) = seeded_auth(&state, "admin").await;
    // Seed another credential + session; revoking the credential
    // should cascade to its sessions.
    let (target_cookie, _target_csrf) = seeded_auth(&state, "target-device").await;

    let router = app(state.clone());
    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/auth/devices/target-device")
                .header(header::COOKIE, format!("katulong_session={admin_cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

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
async fn revoke_device_is_idempotent() {
    // Unknown or already-gone id: 204. Caller can't distinguish
    // "never existed" from "already removed," which matches the
    // idempotent-DELETE semantics of the setup-token path.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;
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
                .uri("/api/auth/devices/never-existed")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn revoke_last_credential_from_remote_is_blocked() {
    // Single credential + remote caller. Guard fires → 409
    // last_credential.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "only-device").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri("/api/auth/devices/only-device")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert_eq!(v["error"]["code"], "last_credential");
}

#[tokio::test]
async fn revoke_last_credential_from_localhost_is_allowed() {
    // Same last-credential scenario, but caller is localhost. Physical
    // access trumps the lockout concern — Node scar f25855f.
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
                .uri("/api/auth/devices/only-device")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let snap = state.auth_store.snapshot().await;
    assert!(snap.credentials.is_empty());
}
