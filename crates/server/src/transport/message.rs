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
//! # Byte-string encoding for `Input`/`Output`
//!
//! `Input { data }` and `Output { data }` carry raw terminal bytes
//! (keystroke input, PTY output). Their `data` fields are
//! annotated `#[serde(with = "serde_bytes")]` so CBOR emits a
//! major-type-2 byte string instead of the serde-default array of
//! small integers. Without the annotation, a 1 KiB paste would
//! encode as ~1–2 KiB of integer elements; with it the payload
//! rides the wire literally. JSON callers would see base64 — fine,
//! because there are none: session-layer messages only ever travel
//! as CBOR.
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
//! # Handshake & session binding (slice 9e)
//!
//! The protocol is a three-step gate before terminal I/O is valid:
//!
//! 1. **Server → Client: `Hello { protocol_version }`** on upgrade.
//!    Client refuses if the version doesn't match its expected
//!    value.
//! 2. **Client → Server: `HelloAck { protocol_version }`.** The
//!    server re-validates the version — belt-and-suspenders against
//!    a pinned client speaking an older protocol that happens to
//!    overlap. On mismatch the server emits `Error { code:
//!    "protocol_version_mismatch", ... }` and closes.
//! 3. **Client → Server: `Attach { session, cols, rows }`.** Binds
//!    this transport to a tmux session. Server replies with
//!    `Attached { session, cols, rows }` (the clamped dims that
//!    actually landed on tmux).
//!
//! Only after `Attached` are `Input` and `Resize` accepted.
//! Sending either earlier triggers `Error { code:
//! "unexpected_message", ... }` and the transport closes.
//!
//! `Ping`/`Pong` is allowed in every phase — liveness is orthogonal
//! to the handshake.

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

    /// Acknowledge the server's `Hello` and confirm the client
    /// speaks the same protocol version. Sent exactly once, as the
    /// first message after the client receives `Hello`. The server
    /// re-checks the version and closes on mismatch.
    HelloAck { protocol_version: String },

    /// Bind this transport to a tmux session. `session` is the tmux
    /// session name (validated by `SessionManager`); `cols`/`rows`
    /// are the client's current window dimensions (clamped
    /// defensively server-side per `session::dims`). Sent exactly
    /// once after `HelloAck`. The server creates the session if it
    /// doesn't exist (or attaches to the existing one) and replies
    /// with `Attached`.
    Attach {
        session: String,
        cols: u16,
        rows: u16,
    },

    /// Keystroke / paste input destined for the PTY. Only valid
    /// after `Attached`. Slice 9e validates and accepts but does
    /// not forward — slice 9f wires the tmux write path.
    Input {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },

    /// Window-resize notification. Only valid after `Attached`.
    /// Forwarded to the session manager, which clamps and issues a
    /// tmux `refresh-client -C`. Do NOT send on every keystroke —
    /// see `session::dims` for the SIGWINCH-storm history.
    Resize { cols: u16, rows: u16 },
}

/// Messages sent by the server to the client.
///
/// Serialized as CBOR binary frames. Clients treat any message with
/// an unknown `type` field as a forward-compat signal and log but
/// don't reject — we want server → client additions to be
/// deployable without client pinning.
///
/// **Slice-9e byte-heavy variants (`Output`).** When slice 9f
/// starts producing `Output { data: Vec<u8>, seq: u64 }`, CBOR
/// encodes `data` as a byte-string (via `serde_bytes`) with the
/// usual per-frame map overhead (the `type` key + map structure is
/// a few bytes). That's fine IF the session layer coalesces output
/// into chunks above ~256 bytes before sending. If it forwards
/// one-escape-per-frame from tmux, the map-per-message overhead
/// becomes measurable. The existing `d311168`/`066dab2` Node scars
/// (2 ms idle / 16 ms cap coalescing) are the right defense; they
/// sit in the session layer, not here. Just: don't let 9f ship an
/// uncoalesced per-frame-per-escape output path and blame the
/// encoding.
///
/// **Asymmetry with `ClientMessage`.** `deny_unknown_fields` is
/// deliberately OMITTED here. The strict boundary is INBOUND: the
/// server rejects unknown client input because that's untrusted
/// data. Outbound messages from the server are produced by our
/// own code; relaxing this direction lets older Rust clients
/// (tests, migration tools, federation relays) deserialize
/// newer-server output without hard-failing on fields they don't
/// understand.
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
    /// Confirms that this transport is bound to `session`, which
    /// has been resized to the clamped `cols`/`rows`. The client
    /// should use these (not what it requested) as the authoritative
    /// dimensions for its local renderer.
    Attached {
        session: String,
        cols: u16,
        rows: u16,
    },
    /// PTY output chunk. `seq` is a monotonic counter per
    /// connection that lets clients detect gaps after a reconnect
    /// (Node scar `da6907f`). Slice 9e defines the variant; slice
    /// 9f populates it from the tmux `%output` notification stream
    /// with coalescing (`d311168`/`066dab2`).
    Output {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        seq: u64,
    },
    /// Protocol-level error. The server sends this right before
    /// closing the transport so the client sees a concrete reason
    /// in logs rather than an opaque WS close frame.
    ///
    /// `code` is a stable machine-readable token (e.g.
    /// `"protocol_version_mismatch"`, `"unexpected_message"`);
    /// `message` is a human-readable operator-visible string. The
    /// code stays stable across releases so scripts and client
    /// error classifiers key off it.
    Error { code: String, message: String },
}

#[cfg(test)]
mod tests {
    // Most tests here use JSON as the serialization medium because
    // it's human-readable in assertions — but the production wire
    // is CBOR. The serde attributes under test (`tag`,
    // `deny_unknown_fields`, etc.) are format-agnostic, so a serde
    // behavior proven with JSON also holds on CBOR. Two CBOR
    // roundtrip tests at the end lock in the production encoding.
    //
    // NOTE: the `serde_bytes` annotation on `Input`/`Output.data`
    // forces CBOR byte-string encoding but produces base64-style
    // arrays under JSON. Tests that assert on byte content roundtrip
    // through CBOR specifically.
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
    fn client_hello_ack_serde_roundtrip() {
        let m = ClientMessage::HelloAck {
            protocol_version: PROTOCOL_VERSION.into(),
        };
        let s = to_string(&m).unwrap();
        assert!(s.contains(r#""type":"hello_ack""#));
        assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
    }

    #[test]
    fn client_attach_serde_roundtrip() {
        let m = ClientMessage::Attach {
            session: "main".into(),
            cols: 120,
            rows: 40,
        };
        let s = to_string(&m).unwrap();
        assert!(s.contains(r#""type":"attach""#));
        assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
    }

    #[test]
    fn server_attached_serde_roundtrip() {
        let m = ServerMessage::Attached {
            session: "main".into(),
            cols: 120,
            rows: 40,
        };
        let s = to_string(&m).unwrap();
        assert!(s.contains(r#""type":"attached""#));
        assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
    }

    #[test]
    fn client_resize_serde_roundtrip() {
        let m = ClientMessage::Resize {
            cols: 80,
            rows: 24,
        };
        let s = to_string(&m).unwrap();
        assert!(s.contains(r#""type":"resize""#));
        assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
    }

    #[test]
    fn server_error_serde_roundtrip() {
        let m = ServerMessage::Error {
            code: "protocol_version_mismatch".into(),
            message: "expected katulong/0.1, got katulong/0.2".into(),
        };
        let s = to_string(&m).unwrap();
        assert!(s.contains(r#""type":"error""#));
        assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
    }

    #[test]
    fn unknown_type_is_rejected() {
        // Server adds a new variant; an older client shouldn't see
        // a silent "ClientMessage::Unknown" — it should fail to
        // parse, so the server knows the client doesn't speak this
        // protocol version.
        let err = from_str::<ClientMessage>(r#"{"type":"output","data":[1,2,3],"seq":1}"#);
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
    fn resize_oversize_value_parses_then_server_clamps() {
        // Serde deserializes any u16 value; clamping is the session
        // layer's responsibility via `session::dims::clamp_dims`.
        // This test is a reminder that the PARSER accepts the
        // number — any out-of-range value must be caught downstream,
        // not here.
        let m: ClientMessage = from_str(r#"{"type":"resize","cols":9999,"rows":9999}"#).unwrap();
        assert_eq!(
            m,
            ClientMessage::Resize {
                cols: 9999,
                rows: 9999
            }
        );
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

    #[test]
    fn cbor_input_encodes_data_as_byte_string() {
        // The `serde_bytes` annotation is load-bearing for wire
        // efficiency: without it, `Vec<u8>` encodes as a CBOR
        // array of small integers (each byte takes 1–2 bytes of
        // overhead). With it, CBOR major-type-2 byte-string carries
        // the payload literally.
        //
        // Empirical check: a 256-byte payload should encode to
        // well under 300 bytes total (a few bytes of envelope +
        // the 256 raw bytes + small length prefix). Array encoding
        // would land north of 400 bytes because each 0..255 integer
        // takes 1–2 bytes.
        let data = vec![0xABu8; 256];
        let original = ClientMessage::Input { data: data.clone() };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        assert!(
            buf.len() < 300,
            "Input data field must encode as byte-string, \
             not array-of-int; encoded {} bytes for 256 payload bytes",
            buf.len()
        );
        let back: ClientMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, ClientMessage::Input { data });
    }

    #[test]
    fn cbor_output_roundtrip_preserves_seq_and_bytes() {
        let original = ServerMessage::Output {
            data: vec![0x01, 0x1b, 0x5b, 0x48],
            seq: 42,
        };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        let back: ServerMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, original);
    }
}
