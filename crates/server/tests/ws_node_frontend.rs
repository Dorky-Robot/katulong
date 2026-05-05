//! Phase 0b contract test: the Rust server's WS protocol must be
//! byte-compatible with the Node SPA's existing client in
//! `public/lib/ws-message-handlers.js`.
//!
//! What this file tests
//! --------------------
//!
//! These tests pin the JSON wire shape of every message the Node
//! SPA sends or expects. They DO NOT spin up tmux or drive
//! `serve_session` end-to-end (that lives behind `#[ignore]` in
//! `session::handler` and `session::manager` because it needs a
//! real tmux binary). What they DO is round-trip every wire frame
//! through `serde_json` against a concrete byte-string the SPA
//! actually emits — if the rename annotation, variant tag, or
//! field order ever drifts, this file fires before an operator
//! finds out via a broken terminal.
//!
//! End-to-end coverage of the attach→input→output flow with a
//! real tmux is the operator-smoke test plan in the PR
//! description; the unit-level JSON-shape coverage here is the
//! cheap regression net that catches the nine-of-ten ways the
//! wire could drift without operator-time setup.

use katulong_shared::wire::{ClientMessage, ServerMessage};
use serde_json::{from_str, json, to_string, Value};

/// Reads a Node-SPA-style frame and confirms the Rust enum
/// deserialises to the expected variant + fields. The closure
/// pattern keeps each test focused on the wire bytes; the
/// destructuring is in one place per test.
fn assert_decodes<F: FnOnce(ClientMessage)>(json: &str, check: F) {
    let m: ClientMessage = from_str(json)
        .unwrap_or_else(|e| panic!("decode failed for {json:?}: {e}"));
    check(m);
}

// ---------- Inbound frames the SPA sends ----------

#[test]
fn spa_attach_decodes() {
    // Shape from `public/lib/ws-message-handlers.js`'s
    // attach call. No `fromSeq` on a fresh attach; cols/rows
    // from the xterm fit-addon.
    let frame = r#"{"type":"attach","session":"main","cols":120,"rows":40}"#;
    assert_decodes(frame, |m| {
        assert!(matches!(
            m,
            ClientMessage::Attach {
                session,
                cols: 120,
                rows: 40,
                from_seq: None,
            } if session == "main"
        ));
    });
}

#[test]
fn spa_attach_with_resume_cursor_decodes() {
    let frame =
        r#"{"type":"attach","session":"main","cols":80,"rows":24,"fromSeq":12345}"#;
    assert_decodes(frame, |m| {
        let ClientMessage::Attach { from_seq, .. } = m else {
            panic!("expected Attach");
        };
        assert_eq!(from_seq, Some(12345));
    });
}

#[test]
fn spa_input_decodes_with_string_data() {
    // The SPA sends `{type, data}` where `data` is the
    // keystroke string. Note the JSON-escaped `[` for ANSI
    // escape: `JSON.stringify("[A")` produces `"[A"`.
    let frame = r#"{"type":"input","data":"\u001b[A"}"#;
    assert_decodes(frame, |m| {
        let ClientMessage::Input { data, session } = m else {
            panic!("expected Input");
        };
        assert_eq!(data, "\u{1b}[A");
        assert!(session.is_none());
    });
}

#[test]
fn spa_input_with_explicit_session_decodes() {
    // The SPA sends an explicit `session` when it has multiple
    // tabs open (per `lib/ws-manager.js:404-406`).
    let frame = r#"{"type":"input","data":"ls\n","session":"work"}"#;
    assert_decodes(frame, |m| {
        let ClientMessage::Input { data, session } = m else {
            panic!("expected Input");
        };
        assert_eq!(data, "ls\n");
        assert_eq!(session.as_deref(), Some("work"));
    });
}

#[test]
fn spa_resize_decodes() {
    let frame = r#"{"type":"resize","cols":100,"rows":30}"#;
    assert_decodes(frame, |m| {
        assert!(matches!(
            m,
            ClientMessage::Resize {
                cols: 100,
                rows: 30,
                session: None,
            }
        ));
    });
}

#[test]
fn spa_pull_decodes_with_camelcase_from_seq() {
    let frame = r#"{"type":"pull","fromSeq":42,"session":"main"}"#;
    assert_decodes(frame, |m| {
        let ClientMessage::Pull { from_seq, session } = m else {
            panic!("expected Pull");
        };
        assert_eq!(from_seq, 42);
        assert_eq!(session.as_deref(), Some("main"));
    });
}

#[test]
fn spa_subscribe_decodes() {
    assert_decodes(r#"{"type":"subscribe","session":"alt"}"#, |m| {
        assert!(matches!(m, ClientMessage::Subscribe { session } if session == "alt"));
    });
}

#[test]
fn spa_unsubscribe_decodes() {
    assert_decodes(r#"{"type":"unsubscribe","session":"alt"}"#, |m| {
        assert!(matches!(m, ClientMessage::Unsubscribe { session } if session == "alt"));
    });
}

#[test]
fn spa_switch_decodes() {
    let frame = r#"{"type":"switch","session":"alt","cols":80,"rows":24}"#;
    assert_decodes(frame, |m| {
        assert!(matches!(
            m,
            ClientMessage::Switch {
                session,
                cols: 80,
                rows: 24,
            } if session == "alt"
        ));
    });
}

#[test]
fn spa_resync_decodes() {
    assert_decodes(r#"{"type":"resync","session":"main"}"#, |m| {
        assert!(matches!(m, ClientMessage::Resync { session } if session == "main"));
    });
}

#[test]
fn spa_set_tab_icon_decodes_with_literal_hyphen() {
    // CRITICAL: the wire uses a literal HYPHEN, not snake_case
    // (`set-tab-icon`, not `set_tab_icon`). `lib/websocket-validation.js`
    // hard-codes the hyphenated form.
    assert_decodes(
        r#"{"type":"set-tab-icon","session":"main","icon":"🐛"}"#,
        |m| {
            let ClientMessage::SetTabIcon { session, icon } = m else {
                panic!("expected SetTabIcon");
            };
            assert_eq!(session, "main");
            assert_eq!(icon.as_deref(), Some("\u{1f41b}"));
        },
    );
}

#[test]
fn spa_set_tab_icon_null_decodes() {
    assert_decodes(
        r#"{"type":"set-tab-icon","session":"main","icon":null}"#,
        |m| {
            let ClientMessage::SetTabIcon { icon, .. } = m else {
                panic!("expected SetTabIcon");
            };
            assert!(icon.is_none());
        },
    );
}

#[test]
fn spa_ping_decodes_without_nonce() {
    // Phase 0b cutover dropped the `nonce` field — Node's
    // app-level ping is keepalive only. The wire shape is
    // `{type:"ping"}` and the response is `{type:"pong"}`.
    assert_decodes(r#"{"type":"ping"}"#, |m| {
        assert!(matches!(m, ClientMessage::Ping));
    });
}

#[test]
fn spa_rtc_offer_decodes_as_stub() {
    // Phase 0b stubs WebRTC signaling so the SPA's speculative
    // upgrade attempts get a clean error reply rather than a
    // protocol-violation close.
    assert_decodes(r#"{"type":"rtc-offer","sdp":"v=0\r\n"}"#, |m| {
        assert!(matches!(m, ClientMessage::RtcOffer { .. }));
    });
}

#[test]
fn spa_rtc_ice_candidate_decodes_as_stub() {
    let frame = r#"{"type":"rtc-ice-candidate","candidate":{"candidate":"candidate:1 1 UDP 2122252543 192.0.2.1 50000 typ host","sdpMid":"0"}}"#;
    assert_decodes(frame, |m| {
        assert!(matches!(m, ClientMessage::RtcIceCandidate { .. }));
    });
}

#[test]
fn unknown_type_fails_decode() {
    // The Node validator rejects unrecognised types; the Rust
    // parser does the same via serde's tagged-enum exhaustive
    // match.
    assert!(from_str::<ClientMessage>(r#"{"type":"output"}"#).is_err());
    assert!(from_str::<ClientMessage>(r#"{"type":""}"#).is_err());
    assert!(from_str::<ClientMessage>(r#"{}"#).is_err());
}

// ---------- Outbound frames the SPA expects ----------

#[test]
fn server_attached_emits_session_and_string_data() {
    let json = to_string(&ServerMessage::Attached {
        session: "main".into(),
        data: String::new(),
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "attached");
    assert_eq!(v["session"], "main");
    assert_eq!(v["data"], "");
    // No `cols`/`rows`/`last_seq` — the SPA reads only `data`
    // (and `session` for routing). Pre-cutover wire carried
    // `last_seq`; phase 0b moved that to a separate `seq-init`.
    assert!(v.get("cols").is_none());
    assert!(v.get("rows").is_none());
    assert!(v.get("last_seq").is_none());
}

#[test]
fn server_seq_init_emits_session_and_seq() {
    let json = to_string(&ServerMessage::SeqInit {
        session: "main".into(),
        seq: 42,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "seq-init");
    assert_eq!(v["session"], "main");
    assert_eq!(v["seq"], 42);
}

#[test]
fn server_output_emits_camelcase_from_seq_and_cursor() {
    // Wire-shape canary: pinned to `lib/ws-manager.js:127-129`.
    // Renaming `fromSeq`/`cursor` is a wire break with the SPA.
    let json = to_string(&ServerMessage::Output {
        session: "main".into(),
        data: "hi".into(),
        from_seq: 10,
        cursor: 12,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "output");
    assert_eq!(v["session"], "main");
    assert_eq!(v["data"], "hi");
    assert_eq!(v["fromSeq"], 10);
    assert_eq!(v["cursor"], 12);
    // No `seq` — pre-cutover wire used `seq` (== end-of-chunk).
    assert!(v.get("seq").is_none());
}

#[test]
fn server_data_available_emits_session() {
    let json = to_string(&ServerMessage::DataAvailable {
        session: "main".into(),
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "data-available");
    assert_eq!(v["session"], "main");
}

#[test]
fn server_pull_response_emits_session_data_cursor() {
    let json = to_string(&ServerMessage::PullResponse {
        session: "main".into(),
        data: "tail".into(),
        cursor: 100,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "pull-response");
    assert_eq!(v["session"], "main");
    assert_eq!(v["data"], "tail");
    assert_eq!(v["cursor"], 100);
}

#[test]
fn server_pull_snapshot_emits_session_data_cursor() {
    let json = to_string(&ServerMessage::PullSnapshot {
        session: "main".into(),
        data: "fresh".into(),
        cursor: 999,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "pull-snapshot");
    assert_eq!(v["session"], "main");
    assert_eq!(v["data"], "fresh");
    assert_eq!(v["cursor"], 999);
}

#[test]
fn server_exit_emits_session_and_code() {
    let json = to_string(&ServerMessage::Exit {
        session: "main".into(),
        code: -1,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "exit");
    assert_eq!(v["session"], "main");
    assert_eq!(v["code"], -1);
}

#[test]
fn server_error_omits_code_when_none() {
    // The Node SPA's error handler reads `msg.message`; the
    // `code` field is server-side metadata only. Optional via
    // `skip_serializing_if`.
    let json = to_string(&ServerMessage::Error {
        message: "Invalid message format".into(),
        code: None,
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["message"], "Invalid message format");
    assert!(v.get("code").is_none());
}

#[test]
fn server_error_includes_code_when_some() {
    let json = to_string(&ServerMessage::Error {
        message: "not yet implemented".into(),
        code: Some("not_yet_implemented".into()),
    })
    .unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["code"], "not_yet_implemented");
}

#[test]
fn server_pong_emits_no_nonce() {
    // Phase 0b dropped the `nonce` field on both ping and pong
    // — they're keepalive-only now. If this test fires, the
    // SPA's `pong` handler will still work (it doesn't read
    // any field), but the test pins the contract.
    let json = to_string(&ServerMessage::Pong).unwrap();
    let v: Value = from_str(&json).unwrap();
    assert_eq!(v["type"], "pong");
    assert!(v.as_object().unwrap().len() == 1);
}

// ---------- Smoke: SPA → server → SPA round-trips ----------

#[test]
fn spa_can_decode_server_attached_then_seq_init_then_output() {
    // End-to-end JSON-only smoke: build the three frames the
    // Rust server emits on a fresh attach (`attached`,
    // `seq-init`, then live `output` once the shell repaints),
    // confirm they decode as the expected SPA shapes via
    // serde_json::Value (the SPA's JSON.parse equivalent).
    let attached = json!({"type": "attached", "session": "main", "data": ""});
    let seq_init = json!({"type": "seq-init", "session": "main", "seq": 0});
    let output = json!({
        "type": "output",
        "session": "main",
        "data": "$ ",
        "fromSeq": 0,
        "cursor": 2,
    });

    // The Rust server must produce frames whose JSON.stringify
    // matches the SPA's expectations. We round-trip through
    // ServerMessage + back to Value to confirm the shape.
    let from_rust = to_string(&ServerMessage::Attached {
        session: "main".into(),
        data: String::new(),
    })
    .unwrap();
    assert_eq!(from_str::<Value>(&from_rust).unwrap(), attached);

    let from_rust = to_string(&ServerMessage::SeqInit {
        session: "main".into(),
        seq: 0,
    })
    .unwrap();
    assert_eq!(from_str::<Value>(&from_rust).unwrap(), seq_init);

    let from_rust = to_string(&ServerMessage::Output {
        session: "main".into(),
        data: "$ ".into(),
        from_seq: 0,
        cursor: 2,
    })
    .unwrap();
    assert_eq!(from_str::<Value>(&from_rust).unwrap(), output);
}
