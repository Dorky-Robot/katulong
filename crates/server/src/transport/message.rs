//! Typed wire protocol for the session layer.
//!
//! Every message crossing the transport boundary is one of these
//! variants — no `serde_json::Value` catch-alls, no loosely-typed
//! payloads. The Node scar that motivated this (`9dc7c78`) was a
//! terminal that accepted unvalidated JSON and passed fields
//! straight to PTY resize/input — `"999999"` where a number was
//! expected could cause type confusion. Rust's types + serde's
//! strictness close that class of bug at parse time; we just have
//! to be disciplined about not reintroducing `Value` as an escape
//! hatch.
//!
//! # Wire format: CBOR
//!
//! Messages encode via CBOR (`ciborium`) into binary frames. JSON
//! is used only for the HTTP API (cookies, error envelopes, token
//! CRUD). See `transport::websocket` for the wire-level rationale
//! — tl;dr: uniform binary over both WS and WebRTC DataChannel, no
//! base64 overhead for byte payloads, smaller wire, same serde
//! derives.
//!
//! # Strictness flags
//!
//! - `#[serde(tag = "type", rename_all = "snake_case")]` — every
//!   message carries a `type` discriminator and snake_case field
//!   names. Missing discriminator fails parsing.
//! - `#[serde(deny_unknown_fields)]` on `ClientMessage` only —
//!   inbound strictness is a security property; outbound
//!   `ServerMessage` stays lenient so older Rust consumers (tests,
//!   federation relays) can deserialize newer-server output
//!   without hard-failing on unknown fields.
//!
//! # Scope for slice 9c/9d
//!
//! Just `Ping`/`Pong` + `Hello`. Enough to exercise the transport
//! abstraction end-to-end. Slice 9e adds terminal messages
//! (`Input`, `Output`, `Resize`, `SessionAttached`, ...).

use serde::{Deserialize, Serialize};

/// Current protocol version. Clients check this against their
/// expected value and refuse to proceed on mismatch. Bumped when
/// a non-backwards-compatible change lands (new required field,
/// removed variant, changed semantics).
pub const PROTOCOL_VERSION: &str = "katulong/0.1";

/// Messages sent by the client to the server.
///
/// Deserialized from each inbound CBOR binary frame. Text frames
/// are rejected by the transport layer. Byte payloads (terminal
/// input, future image paste) carry directly via CBOR's byte-
/// string type — no base64 wrapper needed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    /// Client heartbeat. Server echoes with `Pong` carrying the
    /// same `nonce` — lets the client measure round-trip latency
    /// without assuming a specific transport's heartbeat primitive
    /// (WS Ping frames vs WebRTC DC keep-alives differ).
    Ping { nonce: u64 },
}

/// Messages sent by the server to the client.
///
/// Serialized as CBOR binary frames. Clients treat any message with
/// an unknown `type` field as a forward-compat signal and log but
/// don't reject — we want server → client additions to be
/// deployable without client pinning.
///
/// **Slice-9e note on byte-heavy variants.** When `Output { data:
/// Vec<u8>, ... }` lands, CBOR encodes it as a map with a byte-
/// string field — low overhead per frame (the `type` key + map
/// structure is a few bytes). That's fine IF the session layer
/// coalesces output into chunks above ~256 bytes before sending.
/// If it forwards one-escape-per-frame from tmux, the map-per-
/// message overhead becomes measurable. The existing
/// `d311168`/`066dab2` Node scars (2 ms idle / 16 ms cap
/// coalescing) are the right defense; they sit in the session
/// layer, not here. Just: don't let 9e ship an uncoalesced
/// per-frame-per-escape output path and blame the encoding.
///
/// **Asymmetry with `ClientMessage`.** `deny_unknown_fields` is
/// deliberately OMITTED here. The strict boundary is INBOUND: the
/// server rejects unknown client input because that's untrusted
/// data. Outbound messages from the server are produced by our
/// own code; relaxing this direction lets older Rust clients
/// (tests, migration tools, federation relays) deserialize
/// newer-server output without hard-failing on fields they don't
/// understand. The forward-compat policy in the struct's doc
/// matches the serde attributes structurally, not just
/// aspirationally.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent immediately after a successful transport upgrade.
    /// Tells the client the connection is live and which protocol
    /// version the server speaks. The client can refuse to
    /// proceed if the version doesn't match its own expectation.
    Hello { protocol_version: String },
    /// Response to a client `Ping`. Echoes the same nonce.
    Pong { nonce: u64 },
}

#[cfg(test)]
mod tests {
    // Most tests here use JSON as the serialization medium because
    // it's human-readable in assertions — but the production wire
    // is CBOR. The serde attributes under test (`tag`,
    // `deny_unknown_fields`, etc.) are format-agnostic, so a serde
    // behavior proven with JSON also holds on CBOR. Two CBOR
    // roundtrip tests at the end lock in the production encoding.
    use super::*;
    use serde_json::{from_str, to_string};

    #[test]
    fn client_ping_serde_roundtrip() {
        let m = ClientMessage::Ping { nonce: 42 };
        let s = to_string(&m).unwrap();
        assert_eq!(s, r#"{"type":"ping","nonce":42}"#);
        let back: ClientMessage = from_str(&s).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn server_hello_and_pong_serde_roundtrip() {
        let hello = ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION.into(),
        };
        let s = to_string(&hello).unwrap();
        assert!(s.contains(r#""type":"hello""#));
        assert_eq!(from_str::<ServerMessage>(&s).unwrap(), hello);

        let pong = ServerMessage::Pong { nonce: 7 };
        let s = to_string(&pong).unwrap();
        assert_eq!(s, r#"{"type":"pong","nonce":7}"#);
        assert_eq!(from_str::<ServerMessage>(&s).unwrap(), pong);
    }

    #[test]
    fn unknown_type_is_rejected() {
        // Server adds a new variant; an older client shouldn't see
        // a silent "ClientMessage::Unknown" — it should fail to
        // parse, so the server knows the client doesn't speak this
        // protocol version.
        let err = from_str::<ClientMessage>(r#"{"type":"resize","cols":80}"#);
        assert!(err.is_err(), "unknown type must fail deserialization");
    }

    #[test]
    fn extra_fields_are_rejected() {
        // `deny_unknown_fields` catches clients that send extras.
        // This is the Node `9dc7c78` scar: untrusted JSON flowing
        // into business logic is how type-confusion bugs sneak in.
        let err = from_str::<ClientMessage>(r#"{"type":"ping","nonce":1,"extra":2}"#);
        assert!(err.is_err(), "unknown fields must fail deserialization");
    }

    #[test]
    fn missing_type_tag_is_rejected() {
        let err = from_str::<ClientMessage>(r#"{"nonce":1}"#);
        assert!(err.is_err(), "missing type discriminator must fail");
    }

    #[test]
    fn wrong_field_type_is_rejected() {
        // `nonce` is u64 — a string must not coerce.
        let err = from_str::<ClientMessage>(r#"{"type":"ping","nonce":"42"}"#);
        assert!(err.is_err(), "string where u64 expected must fail");
    }

    #[test]
    fn cbor_client_message_roundtrip() {
        // Production-wire check. CBOR is what actually rides the
        // transport; JSON is only the test-readability medium for
        // the other cases in this module.
        let original = ClientMessage::Ping { nonce: 0xDEAD_BEEF };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        let back: ClientMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn cbor_server_message_roundtrip() {
        let original = ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION.to_string(),
        };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        let back: ServerMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, original);

        let original = ServerMessage::Pong { nonce: 17 };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        let back: ServerMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, original);
    }
}
