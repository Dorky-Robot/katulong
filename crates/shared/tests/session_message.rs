//! Wire-shape regression tests for the session protocol types.
//!
//! These tests cover the serde behaviors documented in the
//! `katulong_shared::wire` session-protocol section: tagged-enum
//! shape, snake_case field names, `deny_unknown_fields` on inbound
//! messages, byte-string encoding via `serde_bytes`, and CBOR
//! round-trips that match what actually rides the wire.
//!
//! Most assertions use JSON because it's human-readable; the serde
//! attributes under test are format-agnostic, so a behavior proven
//! with JSON also holds on CBOR. Two CBOR-specific tests at the end
//! lock in the production encoding (the `serde_bytes` annotation
//! flips byte-payload encoding format, so its contract has to be
//! checked through CBOR specifically).

use katulong_shared::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
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
fn client_attach_fresh_serde_roundtrip() {
    let m = ClientMessage::Attach {
        session: "main".into(),
        cols: 120,
        rows: 40,
        resume_from_seq: None,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"attach""#));
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_attach_resume_serde_roundtrip() {
    let m = ClientMessage::Attach {
        session: "main".into(),
        cols: 80,
        rows: 24,
        resume_from_seq: Some(12345),
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""resume_from_seq":12345"#));
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_attach_missing_resume_field_defaults_to_none() {
    // Forward-compat: an older client that doesn't know about
    // reconnect deserialises cleanly. `#[serde(default)]` on
    // `Option` fills in `None`.
    let m: ClientMessage =
        from_str(r#"{"type":"attach","session":"main","cols":80,"rows":24}"#).unwrap();
    assert_eq!(
        m,
        ClientMessage::Attach {
            session: "main".into(),
            cols: 80,
            rows: 24,
            resume_from_seq: None,
        }
    );
}

#[test]
fn server_attached_serde_roundtrip() {
    let m = ServerMessage::Attached {
        session: "main".into(),
        cols: 120,
        rows: 40,
        last_seq: 42,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"attached""#));
    assert!(s.contains(r#""last_seq":42"#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_output_gap_serde_roundtrip() {
    let m = ServerMessage::OutputGap {
        available_from_seq: 100,
        last_seq: 500,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"output_gap""#));
    assert!(s.contains(r#""available_from_seq":100"#));
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
    // Server adds a new variant; an older client shouldn't see a
    // silent "ClientMessage::Unknown" — it should fail to parse, so
    // the server knows the client doesn't speak this protocol
    // version.
    let err = from_str::<ClientMessage>(r#"{"type":"output","data":[1,2,3],"seq":1}"#);
    assert!(err.is_err(), "unknown type must fail deserialization");
}

#[test]
fn extra_fields_are_rejected() {
    // `deny_unknown_fields` catches clients that send extras. This is
    // the Node `9dc7c78` scar: untrusted JSON flowing into business
    // logic is how type-confusion bugs sneak in.
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
    // layer's responsibility via `session::dims::clamp_dims`. This
    // test is a reminder that the PARSER accepts the number — any
    // out-of-range value must be caught downstream, not here.
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
    // transport; JSON is only the test-readability medium for the
    // other cases.
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
    // efficiency: without it, `Vec<u8>` encodes as a CBOR array of
    // small integers (each byte takes 1–2 bytes of overhead). With
    // it, CBOR major-type-2 byte-string carries the payload
    // literally.
    //
    // Empirical check: a 256-byte payload should encode to well
    // under 300 bytes total (a few bytes of envelope + the 256 raw
    // bytes + small length prefix). Array encoding would land north
    // of 400 bytes because each 0..255 integer takes 1–2 bytes.
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
