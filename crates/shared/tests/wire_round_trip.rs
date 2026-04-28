//! Wire-format round-trip tests.
//!
//! The point of these tests isn't to verify `serde_json`
//! itself — that's well-tested upstream. The point is:
//!
//! 1. Each struct must remain JSON-deserialisable from the
//!    JSON shape it serialises to. A field rename or a
//!    `#[serde(rename = ...)]` change that breaks the round
//!    trip would slip past the type checker but would fail
//!    here loudly.
//!
//! 2. The JSON keys are part of the HTTP wire contract.
//!    These tests pin them down with literal keys (e.g.,
//!    `challenge_id`, `setup_token`) so a future "let's
//!    rename to camelCase" refactor would have to touch this
//!    file — making the wire-break visible at PR time.
//!
//! Note: we don't fabricate `webauthn-rs-proto` payloads
//! (the credential types). Those have crypto-binary fields
//! (challenge bytes, attestation objects) that are
//! cumbersome to construct without a real authenticator.
//! The integration tests in `crates/server/tests/auth_*.rs`
//! exercise those types end-to-end with the real-server
//! `webauthn-rs` engine on one side and crypto-bogus
//! payloads on the other; that covers the on-the-wire
//! shape. Here we focus on the envelope structs (what
//! WRAPS the credential).

use katulong_shared::wire::{
    AuthFinishResponse, ChallengeId, PairStartRequest,
};
use serde_json::json;

#[test]
fn auth_finish_response_round_trip() {
    let resp = AuthFinishResponse {
        credential_id: "cred-abc".to_string(),
        csrf_token: "csrf-xyz".to_string(),
    };
    let s = serde_json::to_string(&resp).unwrap();
    let back: AuthFinishResponse = serde_json::from_str(&s).unwrap();
    assert_eq!(back.credential_id, "cred-abc");
    assert_eq!(back.csrf_token, "csrf-xyz");
}

#[test]
fn auth_finish_response_uses_snake_case_keys() {
    // Pin the wire keys. Renaming a field on the server
    // without updating the WASM client (or vice versa) would
    // change this output and fail the assertion — making the
    // wire-break visible in code review rather than at
    // runtime.
    let resp = AuthFinishResponse {
        credential_id: "x".to_string(),
        csrf_token: "y".to_string(),
    };
    let value: serde_json::Value = serde_json::to_value(&resp).unwrap();
    assert_eq!(
        value,
        json!({ "credential_id": "x", "csrf_token": "y" })
    );
}

#[test]
fn pair_start_request_round_trip() {
    let req = PairStartRequest {
        setup_token: "deadbeef".to_string(),
    };
    let s = serde_json::to_string(&req).unwrap();
    let back: PairStartRequest = serde_json::from_str(&s).unwrap();
    assert_eq!(back.setup_token, "deadbeef");
}

#[test]
fn pair_start_request_uses_setup_token_key() {
    // The key name `setup_token` is the actual contract the
    // WASM client and the server both care about. The Rust
    // identifier could be renamed; the JSON key must not.
    let req = PairStartRequest {
        setup_token: "t".to_string(),
    };
    let value: serde_json::Value = serde_json::to_value(&req).unwrap();
    assert_eq!(value, json!({ "setup_token": "t" }));
}

#[test]
fn challenge_id_is_a_string() {
    // `ChallengeId` is a type alias for `String`. If it ever
    // becomes a newtype, the wire format may change (could
    // serialize as a tuple struct). Pin the contract: it
    // must serialize to a bare JSON string.
    let id: ChallengeId = "challenge-123".to_string();
    let value: serde_json::Value = serde_json::to_value(&id).unwrap();
    assert_eq!(value, json!("challenge-123"));
}
