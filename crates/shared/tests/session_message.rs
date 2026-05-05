//! Wire-shape regression tests for the session protocol types.
//!
//! Phase 0b of the Node-cutover dropped CBOR for JSON over text
//! frames so the existing Node SPA in `public/lib/...` can drive
//! the Rust server unchanged. These tests pin the JSON shape — if
//! a future refactor changes a field name, a `#[serde(rename = ...)]`
//! string, or the variant tag, this file is the canary.
//!
//! The Node-side contract these mirror lives in:
//! - `lib/ws-manager.js:124-585` (server → client message dispatch)
//! - `lib/websocket-validation.js:33-109` (inbound validators)
//! - `public/lib/ws-message-handlers.js:9-227` (frontend handlers)

use katulong_shared::wire::{ClientMessage, ServerMessage};
use serde_json::{from_str, to_string};

// ---------- ClientMessage ----------

#[test]
fn client_ping_serde_roundtrip() {
    let m = ClientMessage::Ping;
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"ping"}"#);
    let back: ClientMessage = from_str(&s).unwrap();
    assert_eq!(back, m);
}

#[test]
fn client_attach_fresh_serde_roundtrip() {
    // Node SPA's first frame after WS-open: `{type, session, cols, rows}`.
    // No `fromSeq` on a fresh attach.
    let m = ClientMessage::Attach {
        session: "main".into(),
        cols: 120,
        rows: 40,
        from_seq: None,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"attach""#));
    assert!(s.contains(r#""session":"main""#));
    assert!(s.contains(r#""cols":120"#));
    assert!(s.contains(r#""rows":40"#));
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_attach_accepts_camelcase_from_seq_on_wire() {
    // The SPA's pull manager keeps the cursor under `fromSeq` —
    // matching `lib/ws-manager.js`'s `pull` handler. We accept
    // the same spelling on `attach` so a reconnecting client can
    // resume in one round-trip.
    let m: ClientMessage = from_str(
        r#"{"type":"attach","session":"main","cols":80,"rows":24,"fromSeq":12345}"#,
    )
    .unwrap();
    assert_eq!(
        m,
        ClientMessage::Attach {
            session: "main".into(),
            cols: 80,
            rows: 24,
            from_seq: Some(12345),
        }
    );
}

#[test]
fn client_attach_accepts_snake_case_alias() {
    // Forward-compat with the WASM frontend (frozen during
    // cutover) which still emits `from_seq`. Once that crate is
    // updated, the alias can be dropped.
    let m: ClientMessage = from_str(
        r#"{"type":"attach","session":"main","cols":80,"rows":24,"from_seq":7}"#,
    )
    .unwrap();
    let ClientMessage::Attach { from_seq, .. } = m else {
        panic!("expected Attach");
    };
    assert_eq!(from_seq, Some(7));
}

#[test]
fn client_attach_missing_resume_field_defaults_to_none() {
    let m: ClientMessage =
        from_str(r#"{"type":"attach","session":"main","cols":80,"rows":24}"#).unwrap();
    assert_eq!(
        m,
        ClientMessage::Attach {
            session: "main".into(),
            cols: 80,
            rows: 24,
            from_seq: None,
        }
    );
}

#[test]
fn client_input_is_utf8_string_not_bytes() {
    // The Node SPA sends `{type:"input", data: "<keystroke>"}` as
    // a JS string. Pre-cutover Rust used `Vec<u8>` + serde_bytes
    // for CBOR efficiency; phase 0b reverts to plain `String` so
    // the SPA's `JSON.stringify` produces a string field, not an
    // array of small integers. ANSI escapes are JSON-escaped as
    // `\u001b...` on the wire; serde_json decodes them back to
    // the U+001B code point.
    let json = r#"{"type":"input","data":"\u001b[A"}"#;
    let m: ClientMessage = from_str(json).unwrap();
    let ClientMessage::Input { data, session } = m else {
        panic!("expected Input");
    };
    assert_eq!(data, "\u{1b}[A"); // ANSI cursor-up — survives JSON unchanged
    assert!(session.is_none());
}

#[test]
fn client_input_with_optional_session_round_trips() {
    let m = ClientMessage::Input {
        data: "ls\n".into(),
        session: Some("work".into()),
    };
    let s = to_string(&m).unwrap();
    let back: ClientMessage = from_str(&s).unwrap();
    assert_eq!(back, m);
}

#[test]
fn client_resize_round_trips() {
    let m = ClientMessage::Resize {
        cols: 80,
        rows: 24,
        session: None,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"resize""#));
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_pull_uses_camelcase_from_seq_on_wire() {
    let m: ClientMessage = from_str(r#"{"type":"pull","fromSeq":42}"#).unwrap();
    assert_eq!(
        m,
        ClientMessage::Pull {
            from_seq: 42,
            session: None,
        }
    );
    let s = to_string(&m).unwrap();
    assert!(
        s.contains(r#""fromSeq":42"#),
        "outbound JSON must use camelCase fromSeq; got {s}"
    );
}

#[test]
fn client_set_tab_icon_uses_literal_hyphen() {
    // `lib/websocket-validation.js` keys the type as the literal
    // string `"set-tab-icon"` — a hyphen, not snake_case. The
    // serde rename annotation enforces the wire shape.
    let m: ClientMessage = from_str(
        r#"{"type":"set-tab-icon","session":"main","icon":"🐛"}"#,
    )
    .unwrap();
    assert_eq!(
        m,
        ClientMessage::SetTabIcon {
            session: "main".into(),
            icon: Some("\u{1f41b}".into()),
        }
    );
}

#[test]
fn client_set_tab_icon_accepts_null_icon() {
    let m: ClientMessage = from_str(
        r#"{"type":"set-tab-icon","session":"main","icon":null}"#,
    )
    .unwrap();
    let ClientMessage::SetTabIcon { icon, .. } = m else {
        panic!("expected SetTabIcon");
    };
    assert!(icon.is_none());
}

#[test]
fn client_subscribe_round_trips() {
    let m = ClientMessage::Subscribe {
        session: "main".into(),
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"subscribe","session":"main"}"#);
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_switch_round_trips() {
    let m = ClientMessage::Switch {
        session: "alt".into(),
        cols: 100,
        rows: 30,
    };
    let s = to_string(&m).unwrap();
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_resync_round_trips() {
    let m = ClientMessage::Resync {
        session: "main".into(),
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"resync","session":"main"}"#);
    assert_eq!(from_str::<ClientMessage>(&s).unwrap(), m);
}

#[test]
fn client_unknown_type_is_rejected() {
    // The Node validator rejects unrecognised types with
    // `"Invalid message format"`; the Rust parser does the same
    // implicitly via serde's tagged-enum rejection.
    let err = from_str::<ClientMessage>(r#"{"type":"output","data":"x"}"#);
    assert!(err.is_err(), "unknown type must fail deserialization");
}

#[test]
fn client_missing_type_tag_is_rejected() {
    let err = from_str::<ClientMessage>(r#"{"nonce":1}"#);
    assert!(err.is_err(), "missing type discriminator must fail");
}

#[test]
fn client_wrong_field_type_is_rejected() {
    // `cols` is u16 — a string must not coerce.
    let err = from_str::<ClientMessage>(
        r#"{"type":"attach","session":"main","cols":"80","rows":24}"#,
    );
    assert!(err.is_err(), "string where u16 expected must fail");
}

#[test]
fn client_resize_oversize_value_parses_then_handler_clamps() {
    // Serde accepts any u16 value; clamping is handler-side via
    // `session::dims::clamp_dims`. This test pins that contract:
    // the parser does NOT range-check.
    let m: ClientMessage =
        from_str(r#"{"type":"resize","cols":9999,"rows":9999}"#).unwrap();
    assert!(matches!(
        m,
        ClientMessage::Resize {
            cols: 9999,
            rows: 9999,
            ..
        }
    ));
}

// ---------- ServerMessage ----------

#[test]
fn server_pong_round_trips() {
    let m = ServerMessage::Pong;
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"pong"}"#);
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_attached_carries_string_data() {
    // The SPA reads `msg.data` and writes it directly into
    // xterm.js — so it must be a JSON string with raw ANSI
    // escapes preserved.
    let m = ServerMessage::Attached {
        session: "main".into(),
        data: "\u{1b}[2J$ ".into(),
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"attached""#));
    assert!(s.contains(r#""session":"main""#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_seq_init_round_trips() {
    let m = ServerMessage::SeqInit {
        session: "main".into(),
        seq: 42,
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"seq-init","session":"main","seq":42}"#);
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_output_uses_camelcase_from_seq_and_cursor() {
    // Pinned to `lib/ws-manager.js:127-129`: `fromSeq` (camelCase)
    // and `cursor`. Renaming either is a wire break with the SPA.
    let m = ServerMessage::Output {
        session: "main".into(),
        data: "hi".into(),
        from_seq: 10,
        cursor: 12,
    };
    let s = to_string(&m).unwrap();
    assert!(
        s.contains(r#""fromSeq":10"#),
        "outbound JSON must use camelCase fromSeq; got {s}"
    );
    assert!(s.contains(r#""cursor":12"#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_data_available_round_trips() {
    let m = ServerMessage::DataAvailable {
        session: "main".into(),
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"data-available","session":"main"}"#);
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_pull_response_round_trips() {
    let m = ServerMessage::PullResponse {
        session: "main".into(),
        data: "tail".into(),
        cursor: 100,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"pull-response""#));
    assert!(s.contains(r#""cursor":100"#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_pull_snapshot_round_trips() {
    let m = ServerMessage::PullSnapshot {
        session: "main".into(),
        data: "fresh".into(),
        cursor: 999,
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""type":"pull-snapshot""#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_exit_round_trips() {
    let m = ServerMessage::Exit {
        session: "main".into(),
        code: -1,
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"exit","session":"main","code":-1}"#);
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}

#[test]
fn server_error_omits_code_when_none() {
    // Node's error frames are `{type, message}` with no `code`
    // field. We `skip_serializing_if = "Option::is_none"` so the
    // null-vs-absent distinction matches the wire that the SPA
    // is parsing.
    let m = ServerMessage::Error {
        message: "Invalid message format".into(),
        code: None,
    };
    let s = to_string(&m).unwrap();
    assert_eq!(s, r#"{"type":"error","message":"Invalid message format"}"#);
}

#[test]
fn server_error_with_code_round_trips() {
    let m = ServerMessage::Error {
        message: "oversubscribed".into(),
        code: Some("session_oversubscribed".into()),
    };
    let s = to_string(&m).unwrap();
    assert!(s.contains(r#""code":"session_oversubscribed""#));
    assert_eq!(from_str::<ServerMessage>(&s).unwrap(), m);
}
