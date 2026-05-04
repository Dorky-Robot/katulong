//! Shared fixtures for integration tests.
//!
//! Cargo treats `tests/common/mod.rs` (not `tests/common.rs`) as a
//! non-test-binary module, so the helpers here can be used from every
//! `tests/*.rs` file without each being compiled into its own test
//! binary. Consumers declare `mod common;` at the top of each test
//! file.
//!
//! The crate-level `#![allow(dead_code)]` is deliberate: each
//! `tests/*.rs` is its own test binary, and a helper used by one
//! binary appears unused to another. Without the blanket allow, every
//! fixture would need to justify its compilation unit — noise with no
//! corresponding safety benefit.

#![allow(dead_code)]

use axum::{
    body::Body,
    http::{header, request::Builder as RequestBuilder, Request},
};
use http_body_util::BodyExt;
use katulong_auth::{AuthStore, Credential, Session, WebAuthnService, SESSION_TTL};
use katulong_server::state::{AppState, ServerConfig};
use serde_json::Value;
use std::net::SocketAddr;
use std::time::SystemTime;
use tempfile::TempDir;

/// Canonical test config. `cookie_secure = true` matches a remote
/// deployment; tests that specifically need the plain-http loopback
/// path construct their own.
pub fn cfg() -> ServerConfig {
    ServerConfig {
        public_origin: "https://katulong.test".into(),
        rp_id: "katulong.test".into(),
        rp_name: "Katulong Test".into(),
        cookie_secure: true,
    }
}

/// Fresh `AppState` backed by a tempdir-rooted `AuthStore`. The
/// `TempDir` is returned alongside so the caller can keep it in scope
/// for the duration of the test — dropping it early would yank the
/// on-disk state out from under the store.
pub async fn ephemeral_state() -> (AppState, TempDir) {
    let dir = TempDir::new().unwrap();
    let store = AuthStore::open(dir.path().join("auth.json")).await.unwrap();
    let webauthn = WebAuthnService::new("katulong.test", "Katulong Test", "https://katulong.test")
        .unwrap();
    (AppState::new(store, webauthn, cfg()), dir)
}

/// A placeholder `Credential` for tests that need to seed auth state
/// without running a real WebAuthn ceremony. The `public_key` blob is
/// intentionally non-parseable JSON — any test path that tries to
/// deserialize it as a `Passkey` must handle that failure explicitly.
pub fn stub_credential(id: &str) -> Credential {
    Credential {
        id: id.into(),
        public_key: b"{}".to_vec(),
        name: None,
        counter: 0,
        created_at: SystemTime::UNIX_EPOCH,
        setup_token_id: None,
        user_agent: String::new(),
        last_used_at: None,
    }
}

/// Build a request with its `ConnectInfo` peer set as an extension so
/// `ConnectInfo::<SocketAddr>::from_request_parts` can find it. In
/// production axum's `into_make_service_with_connect_info` stamps
/// this on the connection-level service, but tower's `oneshot` path
/// skips that layer, so tests set it manually.
pub fn req(peer: SocketAddr, host: &str) -> RequestBuilder {
    Request::builder()
        .extension(axum::extract::ConnectInfo(peer))
        .header(header::HOST, host)
}

pub fn json_body<T: serde::Serialize>(value: &T) -> Body {
    Body::from(serde_json::to_vec(value).unwrap())
}

pub async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

/// Seed an `AuthStore` with a credential + valid session for
/// `credential_id`, and return the pair `(plaintext_cookie,
/// csrf_token)` that a test can feed back into a CSRF-protected
/// request. Both values are minted by the real `Session::mint` so
/// the hashing + CSRF semantics are exercised end-to-end.
pub async fn seeded_auth(state: &AppState, credential_id: &str) -> (String, String) {
    let cred_id = credential_id.to_string();
    state
        .auth_store
        .clone()
        .transact(move |s| {
            let credential = stub_credential(&cred_id);
            let now = SystemTime::now();
            let (plaintext, session) = Session::mint(cred_id.clone(), now, SESSION_TTL);
            let csrf = session.csrf_token.clone();
            let next = s.upsert_credential(credential).upsert_session(session);
            Ok((next, (plaintext, csrf)))
        })
        .await
        .unwrap()
}
