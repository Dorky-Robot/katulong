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
    // fails fast with `{"error": "Token name is required"}`. The CSRF
    // header is supplied so we exercise the body-validation path
    // rather than the CSRF rejection — the dedicated CSRF tests live
    // below.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "c1").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
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

// ---------------- CSRF on token routes (Phase 0a step 5) ----------------

#[tokio::test]
async fn create_token_without_csrf_is_403() {
    // Step 5 reinstated CSRF on `POST /api/tokens`. A remote
    // caller with a valid cookie but no `x-csrf-token` header
    // gets 403. Without this, an attacker could trick a logged-in
    // admin into minting setup tokens against the live cookie.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "admin").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "iPad" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn create_token_with_wrong_csrf_is_403() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "admin").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", "decoy-value")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "iPad" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn create_token_from_localhost_skips_csrf() {
    // Localhost peers have no session and no paired CSRF token
    // (physical-access trust model). The extractor's localhost
    // bypass means the call succeeds without an `x-csrf-token`
    // header — and must, otherwise the localhost UI couldn't
    // mint setup tokens for the first-device pair flow.
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "first-token" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    // Plaintext token field is `token` (NOT `plaintext`) per
    // step 3's wire reshape — same shape as the remote path.
    assert!(!v["token"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn revoke_token_without_csrf_is_403() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;
    let router = app(state);
    // Mint a token first using a valid CSRF, then try to delete
    // it without one. The two-step shape proves CSRF gates
    // delete independently of create.
    let create = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/api/tokens")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "to-revoke" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let token_id = body_json(create).await["id"].as_str().unwrap().to_string();

    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::DELETE)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn rename_token_without_csrf_is_403() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;
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
                .body(json_body(&json!({ "name": "to-rename" })))
                .unwrap(),
        )
        .await
        .unwrap();
    let token_id = body_json(create).await["id"].as_str().unwrap().to_string();

    let resp = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::PATCH)
                .uri(format!("/api/tokens/{token_id}"))
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(json_body(&json!({ "name": "renamed" })))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
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

// ---------------- /auth/revoke-all (Phase 0a step 6) ----------------
//
// "Sign out everywhere" — wipes every session row, broadcasts a
// close-all event, clears the caller's cookie. Mirrors Node's
// `lib/routes/auth-routes.js:247-259`. Guards: no auth → 401,
// auth-without-CSRF (remote) → 403, fresh-install → 400, success
// → 200 `{"ok": true}` with `Set-Cookie: ...; Max-Age=0`.

#[tokio::test]
async fn revoke_all_without_auth_returns_401() {
    let (state, _dir) = ephemeral_state().await;
    // Seed a credential so we exercise the auth-required path,
    // not the "Not set up" pre-flight.
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("admin")), ())))
        .await
        .unwrap();
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoke_all_remote_without_csrf_returns_403() {
    let (state, _dir) = ephemeral_state().await;
    let (cookie, _csrf) = seeded_auth(&state, "admin").await;
    let resp = app(state)
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoke_all_remote_with_csrf_clears_cookie_and_drops_sessions() {
    // Seed two sessions for the admin so we can prove
    // "every session" is wiped — not just the caller's. The second
    // session is created by directly upserting a manually-built
    // `Session` so we can assert it's gone after the revoke.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;

    // Mint a second session (from a hypothetical second device of
    // the same admin) so the wipe-everything assertion is non-
    // trivial. Use the real `Session::mint` so the hashing path
    // matches production — we then look up by `find_session(plaintext)`.
    let (other_cookie, _other_session) = state
        .auth_store
        .clone()
        .transact(|s| {
            let (plaintext, session) = katulong_auth::Session::mint(
                "admin",
                std::time::SystemTime::now(),
                katulong_auth::SESSION_TTL,
            );
            Ok((s.upsert_session(session.clone()), (plaintext, session)))
        })
        .await
        .unwrap();

    // Sanity: both sessions are in the store before the call.
    {
        let snap = state.auth_store.snapshot().await;
        assert!(snap.find_session(&cookie).is_some());
        assert!(snap.find_session(&other_cookie).is_some());
    }

    let resp = app(state.clone())
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Set-Cookie clears the caller's cookie. Same flag block as
    // logout — Max-Age=0 + Secure (the test config has cookie_secure
    // = true).
    let set_cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        set_cookie.contains("Max-Age=0"),
        "response must clear the cookie: got {set_cookie}"
    );

    // Body matches Node: `{"ok": true}`. Phase 0a step 6 returns
    // 200 with this exact shape — pre-cutover Rust never had this
    // route at all.
    let v = body_json(resp).await;
    assert_eq!(v["ok"], true);

    // Both sessions are gone — the wipe was global, not just the
    // caller's row.
    let snap = state.auth_store.snapshot().await;
    assert!(snap.find_session(&cookie).is_none());
    assert!(snap.find_session(&other_cookie).is_none());
    assert!(
        snap.find_credential("admin").is_some(),
        "credentials are not collateral damage on revoke-all"
    );
}

#[tokio::test]
async fn revoke_all_subsequent_request_with_old_cookie_is_unauthorized() {
    // After revoke-all, the caller's previously-valid cookie no
    // longer authenticates. This is the user-observable invariant
    // that "Sign out everywhere" is selling — covers it explicitly
    // so a future regression that, say, soft-tombstones sessions
    // (instead of removing them) trips this test.
    let (state, _dir) = ephemeral_state().await;
    let (cookie, csrf) = seeded_auth(&state, "admin").await;
    let router = app(state);

    let revoke = router
        .clone()
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);

    // Re-using the same cookie on /api/me must now 401 — the
    // session row is gone, so the auth middleware can't resolve
    // it. /api/me is the smoke-test endpoint that runs the full
    // auth chain, so it's the cheapest place to assert the
    // negative.
    let probe = router
        .oneshot(
            req("203.0.113.5:1234".parse().unwrap(), "katulong.test")
                .method(Method::GET)
                .uri("/api/me")
                .header(header::COOKIE, format!("katulong_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(probe.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoke_all_localhost_without_csrf_succeeds() {
    // Localhost peers have no session and no paired CSRF token
    // (physical-access trust model). The CSRF extractor's
    // localhost bypass means revoke-all is admissible without
    // either a cookie or an x-csrf-token header. The instance
    // must already have a credential — fresh-install is 400
    // (covered separately).
    let (state, _dir) = ephemeral_state().await;
    state
        .auth_store
        .clone()
        .transact(|s| Ok((s.upsert_credential(stub_credential("admin")), ())))
        .await
        .unwrap();
    // Seed a session belonging to that credential so we can
    // assert it gets wiped even when the call originated from
    // localhost.
    let (other_cookie, _) = state
        .auth_store
        .clone()
        .transact(|s| {
            let (plaintext, session) = katulong_auth::Session::mint(
                "admin",
                std::time::SystemTime::now(),
                katulong_auth::SESSION_TTL,
            );
            Ok((s.upsert_session(session.clone()), (plaintext, session)))
        })
        .await
        .unwrap();

    let resp = app(state.clone())
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["ok"], true);

    // The remote-device session got wiped too — revoke-all is
    // global, regardless of who initiated it.
    let snap = state.auth_store.snapshot().await;
    assert!(snap.find_session(&other_cookie).is_none());
}

#[tokio::test]
async fn revoke_all_on_fresh_install_returns_400_not_set_up() {
    // No credentials registered → 400 `{"error": "Not set up"}`,
    // matching Node `lib/routes/auth-routes.js:248-249`. Localhost
    // is the only access path that even reaches this handler on a
    // fresh install (remote without auth → 401 above), so we
    // submit from loopback. The CSRF extractor's localhost bypass
    // means we don't need a cookie or header.
    let (state, _dir) = ephemeral_state().await;
    let resp = app(state)
        .oneshot(
            req("127.0.0.1:1234".parse().unwrap(), "localhost:3000")
                .method(Method::POST)
                .uri("/auth/revoke-all")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let v = body_json(resp).await;
    assert_eq!(v["error"], "Not set up");
}
