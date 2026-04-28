//! Wire-format round-trip tests.
//!
//! Each test pins both halves of the JSON wire contract:
//! the EXACT keys (so a future "rename to camelCase" or
//! `#[serde(rename = ...)]` mistake fails the assertion),
//! AND the round-trip self-consistency (deserialize back to
//! the same fields). Splitting the two concerns into
//! separate tests would create four tests where two suffice
//! and offer no extra signal — a key-pinning failure already
//! implies a round-trip failure.
//!
//! `webauthn-rs-proto` credential types
//! (`PublicKeyCredential`, `RegisterPublicKeyCredential`)
//! are not synthesized here — they have crypto-binary fields
//! (challenge bytes, attestation objects) that are awkward
//! to construct without a real authenticator. The
//! integration tests in `crates/server/tests/auth_*.rs`
//! exercise those types end-to-end via the real
//! `webauthn-rs` engine on one side and crypto-bogus
//! payloads on the other; that covers the on-the-wire
//! shape. Here we focus on the envelope fields
//! (`challenge_id`, `setup_token_id`, `credential_id`,
//! `csrf_token`) — the parts most likely to be silently
//! renamed by a future refactor that doesn't realize the
//! key is part of an HTTP contract.

use katulong_shared::wire::{
    AuthFinishResponse, ChallengeId, LoginFinishRequest, PairFinishRequest,
    PairStartRequest, PairStartResponse,
};
use serde_json::{json, Value};

#[test]
fn auth_finish_response_pins_keys_and_round_trips() {
    let resp = AuthFinishResponse {
        credential_id: "cred-abc".to_string(),
        csrf_token: "csrf-xyz".to_string(),
    };

    let value = serde_json::to_value(&resp).unwrap();
    assert_eq!(
        value,
        json!({ "credential_id": "cred-abc", "csrf_token": "csrf-xyz" })
    );

    let s = serde_json::to_string(&resp).unwrap();
    let back: AuthFinishResponse = serde_json::from_str(&s).unwrap();
    assert_eq!(back.credential_id, "cred-abc");
    assert_eq!(back.csrf_token, "csrf-xyz");
}

#[test]
fn pair_start_request_pins_setup_token_key_and_round_trips() {
    let req = PairStartRequest {
        setup_token: "deadbeef".to_string(),
    };

    let value = serde_json::to_value(&req).unwrap();
    assert_eq!(value, json!({ "setup_token": "deadbeef" }));

    let s = serde_json::to_string(&req).unwrap();
    let back: PairStartRequest = serde_json::from_str(&s).unwrap();
    assert_eq!(back.setup_token, "deadbeef");
}

#[test]
fn login_finish_request_envelope_keys_are_snake_case() {
    // We can't construct a real `PublicKeyCredential` without
    // a live authenticator. Verify the envelope keys
    // (`challenge_id`, `response`) by deserializing a
    // hand-rolled JSON object with a stub credential body
    // that contains only the unconditionally-required fields
    // — the proto types use serde defaults / Option for the
    // rest. If this stops parsing, the proto contract
    // changed underneath us; if the envelope key changed,
    // we'd see the failure here in code review.
    //
    // The `response` body is a `webauthn-rs-proto`
    // `PublicKeyCredential`. Its required fields per the
    // crate docs: `id` (string), `rawId` (base64url bytes),
    // `response.{authenticatorData, clientDataJSON,
    // signature}` (all base64url), and `type` ("public-key").
    let credential_json = json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "type": "public-key",
        "response": {
            "authenticatorData": "AAAA",
            "clientDataJSON": "AAAA",
            "signature": "AAAA"
        }
    });

    let envelope = json!({
        "challenge_id": "c1",
        "response": credential_json,
    });

    // Round-trip via deserialize → re-serialize. A future
    // `#[serde(rename_all = "camelCase")]` on the envelope
    // would change `challenge_id` to `challengeId` and break
    // the deserialize step here.
    let parsed: LoginFinishRequest = serde_json::from_value(envelope.clone()).unwrap();
    let re_serialized = serde_json::to_value(&parsed).unwrap();

    // The envelope keys must match. We don't compare the
    // `response` body byte-for-byte because the proto
    // struct's serializer may emit a canonical form that
    // differs from our hand-rolled JSON; instead we assert
    // the `response` key exists with an object value.
    assert_eq!(re_serialized["challenge_id"], json!("c1"));
    assert!(re_serialized["response"].is_object());
}

#[test]
fn pair_finish_request_envelope_keys_are_snake_case() {
    let credential_json = json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "type": "public-key",
        "response": {
            // RegisterPublicKeyCredential needs the
            // attestation response shape: clientDataJSON +
            // attestationObject.
            "clientDataJSON": "AAAA",
            "attestationObject": "AAAA",
        }
    });

    let envelope = json!({
        "challenge_id": "c1",
        "setup_token_id": "tok-id-1",
        "response": credential_json,
    });

    let parsed: PairFinishRequest = serde_json::from_value(envelope).unwrap();
    let re_serialized = serde_json::to_value(&parsed).unwrap();

    assert_eq!(re_serialized["challenge_id"], json!("c1"));
    assert_eq!(re_serialized["setup_token_id"], json!("tok-id-1"));
    assert!(re_serialized["response"].is_object());
}

#[test]
fn pair_start_response_envelope_keys_are_snake_case() {
    // The `options` field carries a real
    // `CreationChallengeResponse`, which has its own complex
    // shape. We deserialize an envelope and re-serialize it
    // to verify the wrapper keys round-trip.
    //
    // Construct a minimal `CreationChallengeResponse`
    // payload — it has `publicKey` (the actual options
    // object) as the load-bearing field. The other fields
    // (`mediation`, etc.) are optional.
    let options_json = json!({
        "publicKey": {
            "rp": { "name": "katulong", "id": "katulong.test" },
            "user": {
                "id": "AAAA",
                "name": "u",
                "displayName": "u",
            },
            "challenge": "AAAA",
            "pubKeyCredParams": [],
        }
    });

    let envelope = json!({
        "challenge_id": "c1",
        "setup_token_id": "tok-id-1",
        "options": options_json,
    });

    let parsed: PairStartResponse = serde_json::from_value(envelope).unwrap();
    let re_serialized = serde_json::to_value(&parsed).unwrap();

    assert_eq!(re_serialized["challenge_id"], json!("c1"));
    assert_eq!(re_serialized["setup_token_id"], json!("tok-id-1"));
    assert!(re_serialized["options"].is_object());
}

#[test]
fn challenge_id_serializes_as_bare_string() {
    // `ChallengeId` is `type ChallengeId = String`. A future
    // newtype-ification (e.g., `struct ChallengeId(String)`)
    // could change serialization to a single-element tuple
    // struct unless `#[serde(transparent)]` is added. Pin
    // the contract: it must serialize to a bare JSON string.
    let id: ChallengeId = "challenge-123".to_string();
    let value: Value = serde_json::to_value(&id).unwrap();
    assert_eq!(value, json!("challenge-123"));
}
