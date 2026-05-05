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
    AccessMethod, AuthFinishResponse, AuthStatusResponse, LoginFinishRequest,
    RegisterFinishRequest, RegisterOptionsRequest, TileDescriptor, TileId, TileKind, TileLayout,
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
fn register_options_request_round_trips_with_and_without_setup_token() {
    // Phase 0a step 4 collapsed `/auth/pair/options` into
    // `/auth/register/options`. The server branches on
    // `setupToken` presence: absent → first-device
    // localhost-only; present → setup-token-gated pair.
    //
    // Wire shape is camelCase (`setupToken`) to match Node's
    // `public/login.js` which uses `JSON.stringify({ setupToken })`.
    // An empty body deserialises with `setup_token = None` via
    // `serde(default)`.

    // Without setup_token: serialises out with the field omitted
    // (per `skip_serializing_if`).
    let req = RegisterOptionsRequest::default();
    let value = serde_json::to_value(&req).unwrap();
    assert!(value.get("setupToken").is_none());
    assert!(value.get("setup_token").is_none());

    // An empty `{}` body deserialises into `None`.
    let parsed: RegisterOptionsRequest = serde_json::from_value(json!({})).unwrap();
    assert!(parsed.setup_token.is_none());

    // With setup_token: the wire field is camelCase `setupToken`.
    let req = RegisterOptionsRequest {
        setup_token: Some("deadbeef".to_string()),
    };
    let value = serde_json::to_value(&req).unwrap();
    assert_eq!(value, json!({ "setupToken": "deadbeef" }));
    let back: RegisterOptionsRequest = serde_json::from_value(value).unwrap();
    assert_eq!(back.setup_token.as_deref(), Some("deadbeef"));
}

#[test]
fn login_finish_request_envelope_keys_are_snake_case() {
    // The cutover collapsed the request shape to
    // `{ credential: <PublicKeyCredential> }` — the
    // server-issued `challenge_id` is gone, recovered from
    // `clientDataJSON.challenge` instead.
    //
    // The `credential` body is a `webauthn-rs-proto`
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
        "credential": credential_json,
    });

    let parsed: LoginFinishRequest = serde_json::from_value(envelope.clone()).unwrap();
    let re_serialized = serde_json::to_value(&parsed).unwrap();

    // Confirm no challenge envelope leaked into the
    // serialized output, and the `credential` key is intact.
    assert!(re_serialized.get("challenge_id").is_none());
    assert!(re_serialized["credential"].is_object());
}

#[test]
fn register_finish_request_carries_optional_setup_token() {
    // `RegisterFinishRequest` is `rename_all = "camelCase"`, so the
    // wire field is `setupToken` (matching Node's
    // `JSON.stringify({ setupToken })` in `public/login.js`).
    // Phase 0a step 4 merged the pair flow into this body — `Some`
    // selects the token-gated pair finish, `None` selects the
    // first-device localhost-only finish.
    let credential_json = json!({
        "id": "AAAA",
        "rawId": "AAAA",
        "type": "public-key",
        "response": {
            "clientDataJSON": "AAAA",
            "attestationObject": "AAAA",
        }
    });

    // Without setupToken: round-trip should NOT emit the field.
    let envelope = json!({ "credential": credential_json.clone() });
    let parsed: RegisterFinishRequest = serde_json::from_value(envelope).unwrap();
    let re_serialized = serde_json::to_value(&parsed).unwrap();
    assert!(re_serialized.get("setupToken").is_none());
    assert!(re_serialized.get("setup_token").is_none());
    assert!(re_serialized["credential"].is_object());

    // With setupToken: round-trips through the camelCase field.
    let envelope = json!({
        "credential": credential_json,
        "setupToken": "tok-plaintext",
    });
    let parsed: RegisterFinishRequest = serde_json::from_value(envelope).unwrap();
    assert_eq!(parsed.setup_token.as_deref(), Some("tok-plaintext"));
    let re_serialized = serde_json::to_value(&parsed).unwrap();
    assert_eq!(re_serialized["setupToken"], json!("tok-plaintext"));
    // The pair-flow leg of the merged endpoint reads the same field
    // — no separate `PairFinishRequest` exists post-step-4.
    assert!(re_serialized.get("challenge_id").is_none());
    assert!(re_serialized.get("setup_token_id").is_none());
}

#[test]
fn auth_status_response_pins_keys_and_round_trips() {
    let resp = AuthStatusResponse {
        setup: true,
        access_method: AccessMethod::Localhost,
    };

    let value = serde_json::to_value(&resp).unwrap();
    // Wire shape mirrors Node: `{setup, accessMethod}`
    // (camelCase). The `authenticated` field is gone; the
    // `accessMethod` rename is at the wire boundary only.
    assert_eq!(
        value,
        json!({
            "setup": true,
            "accessMethod": "localhost",
        })
    );

    // Cover the other variant too — the WASM client switches
    // on this string and a missed `Remote => "remote"` case
    // would silently treat tunnel access as localhost.
    let remote = AuthStatusResponse {
        setup: false,
        access_method: AccessMethod::Remote,
    };
    let v = serde_json::to_value(&remote).unwrap();
    assert_eq!(v["accessMethod"], json!("remote"));
    assert_eq!(v["setup"], json!(false));

    let s = serde_json::to_string(&resp).unwrap();
    let back: AuthStatusResponse = serde_json::from_str(&s).unwrap();
    assert_eq!(back.access_method, AccessMethod::Localhost);
    assert!(back.setup);
}

#[test]
fn tile_id_serializes_as_bare_string() {
    // `TileId` is a `#[serde(transparent)]` newtype around
    // `String`. Removing the transparent attribute would
    // change serialization to a single-element tuple
    // (`["tile-123"]`) and break round-trips with persisted
    // layouts. Pin the contract.
    let id = TileId("tile-123".to_string());
    let value: Value = serde_json::to_value(&id).unwrap();
    assert_eq!(value, json!("tile-123"));
}

#[test]
fn tile_kind_status_serializes_as_tagged_object() {
    // The `Status` variant has no payload; the wire shape is
    // `{"kind": "status"}` because of
    // `#[serde(tag = "kind", rename_all = "snake_case")]` on
    // `TileKind`. Without `rename_all`, the tag would
    // serialize to `"Status"` (capitalised), which would
    // break a round-trip from a persisted lowercase layout.
    let kind = TileKind::Status;
    let value: Value = serde_json::to_value(&kind).unwrap();
    assert_eq!(value, json!({ "kind": "status" }));

    let s = serde_json::to_string(&kind).unwrap();
    let back: TileKind = serde_json::from_str(&s).unwrap();
    assert_eq!(back, TileKind::Status);
}

#[test]
fn tile_kind_terminal_serializes_with_session_id() {
    // The `Terminal` variant has typed props
    // (`session_id: Option<String>`). The wire shape is the
    // tag plus the variant's fields flattened in. Pin both
    // the `None` and `Some` cases — `None` should serialize
    // as `null` (not omit the field) so the tag-and-fields
    // round-trip is symmetrical.
    let kind = TileKind::Terminal { session_id: None };
    let value: Value = serde_json::to_value(&kind).unwrap();
    assert_eq!(
        value,
        json!({ "kind": "terminal", "session_id": null })
    );

    let kind_some = TileKind::Terminal {
        session_id: Some("session-abc".to_string()),
    };
    let value_some: Value = serde_json::to_value(&kind_some).unwrap();
    assert_eq!(
        value_some,
        json!({ "kind": "terminal", "session_id": "session-abc" })
    );

    let s = serde_json::to_string(&kind_some).unwrap();
    let back: TileKind = serde_json::from_str(&s).unwrap();
    assert_eq!(back, kind_some);
}

#[test]
fn tile_layout_round_trips_with_descriptors() {
    // The full layout shape — descriptors keyed by id, an
    // ordered list, and an optional focused id. This is the
    // shape the persistence slice will round-trip to
    // localStorage; pinning it now means the persistence
    // slice doesn't have to re-shape the protocol.
    let term_id = TileId("t-1".to_string());
    let status_id = TileId("s-1".to_string());

    let mut tiles = std::collections::HashMap::new();
    tiles.insert(
        term_id.clone(),
        TileDescriptor {
            id: term_id.clone(),
            kind: TileKind::Terminal { session_id: None },
        },
    );
    tiles.insert(
        status_id.clone(),
        TileDescriptor {
            id: status_id.clone(),
            kind: TileKind::Status,
        },
    );
    let layout = TileLayout {
        tiles,
        order: vec![term_id.clone(), status_id.clone()],
        focused_id: Some(term_id.clone()),
    };

    let s = serde_json::to_string(&layout).unwrap();
    let back: TileLayout = serde_json::from_str(&s).unwrap();
    assert_eq!(back, layout);

    // Verify the JSON keys we depend on exist with the
    // expected shape — a future `#[serde(rename = ...)]`
    // tweak would silently break a persisted layout.
    let value: Value = serde_json::to_value(&layout).unwrap();
    assert!(value["tiles"].is_object());
    assert!(value["order"].is_array());
    assert_eq!(value["focused_id"], json!("t-1"));
}

#[test]
fn tile_descriptor_flattens_kind_at_root() {
    // `TileDescriptor` uses `#[serde(flatten)]` on the
    // `kind` field so the wire shape is
    // `{"id": "...", "kind": "terminal", "session_id": null}`
    // (flat) rather than
    // `{"id": "...", "kind": {"kind": "terminal", "session_id": null}}`
    // (nested). The flat form is what the persistence
    // schema and any future server-side endpoint will see;
    // pinning the shape catches an accidental drop of the
    // `flatten` attribute.
    let desc = TileDescriptor {
        id: TileId("t-1".to_string()),
        kind: TileKind::Terminal {
            session_id: Some("s".to_string()),
        },
    };
    let value: Value = serde_json::to_value(&desc).unwrap();
    assert_eq!(
        value,
        json!({
            "id": "t-1",
            "kind": "terminal",
            "session_id": "s",
        })
    );
}
