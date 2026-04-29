//! Terminal tile — first concrete consumer of the platform's
//! WS dispatch API.
//!
//! On mount: send `Attach { session, cols, rows }` via
//! `WsClient::send`, register a subscriber that filters
//! `ServerMessage::Output { data, .. }` for this tile's
//! session and appends bytes to a local buffer.
//!
//! Rendering today is a `<pre>` element holding the UTF-8-
//! lossy decoding of the byte buffer. ANSI escape sequences
//! show as garbage characters (no terminal emulator yet) —
//! the next slice (9s.4) vendors xterm.js and drops it in
//! place; nothing outside this file changes.
//!
//! Resize handling and keystroke send arrive with xterm in
//! 9s.4 — those need a focused element with key-event
//! integration that xterm provides natively, and bolting an
//! ad-hoc keyboard input onto a `<pre>` would be throwaway.
//!
//! The session-id strategy: descriptor `session_id: None` is
//! the bootstrap-default state ("attach to whatever the
//! default session is"); we map it to a fixed `"main"`
//! string. When `Some(id)` the tile attaches to exactly that
//! id. Future persistence slices populate the descriptor with
//! a stable id; the hardcoded `"main"` fallback covers the
//! pre-persistence path.

use crate::ws::WsClient;
use katulong_shared::wire::{ClientMessage, ServerMessage};
use leptos::*;

/// Default session id used when the tile's descriptor doesn't
/// carry one. The server creates the tmux session lazily on
/// `Attach`, so a fresh page load with no persisted layout
/// always lands on the same well-known session.
const DEFAULT_SESSION_ID: &str = "main";

/// Initial cols/rows for the `Attach` request. The server
/// clamps these defensively, and a future resize slice will
/// recompute from the rendered tile size; for now, an
/// 80×24 terminal is the conservative default that any shell
/// startup banner fits inside.
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

#[component]
pub fn TerminalTile(#[prop(into)] session_id: Option<String>) -> impl IntoView {
    let session_id = session_id.unwrap_or_else(|| DEFAULT_SESSION_ID.to_string());
    let ws = expect_context::<WsClient>();

    // Output buffer — accumulates UTF-8-decoded bytes from
    // every `Output` message addressed to this session. A
    // future xterm-backed renderer replaces the `<pre>` view
    // and the buffer becomes raw bytes piped to xterm; the
    // dispatch path stays the same.
    let buffer = create_rw_signal(String::new());

    // Subscribe to inbound messages. Filter by message variant
    // and (if attach-targeting were stable across multiple
    // tiles) by session id. The server's `Output` variant
    // doesn't carry a session id today — it's keyed at the
    // transport level since one transport binds one session
    // (per `katulong_shared::wire` session-protocol section).
    // Multiple TerminalTiles all attaching to "main" would
    // share the same transport's output; a future slice that
    // supports per-tile sessions adds the disambiguation.
    let sub_buffer = buffer;
    let handle = ws.subscribe(move |msg| {
        if let ServerMessage::Output { data, .. } = msg {
            // UTF-8-lossy decode keeps the rendering robust
            // against partial code points at chunk boundaries
            // — the byte stream IS valid UTF-8 in aggregate
            // but a chunk may split a multi-byte char. xterm
            // in 9s.4 handles this natively; for now lossy
            // decode + accumulation is good enough to display
            // the shell banner and prompts.
            let s = String::from_utf8_lossy(data).to_string();
            sub_buffer.update(|buf| buf.push_str(&s));
        }
    });

    // Keep the subscriber handle alive for the component's
    // lifetime. `store_value` ties it to the component scope;
    // when the tile unmounts (e.g., layout changes focus
    // away in a future multi-tile slice), the handle drops
    // and `Drop` removes the subscriber from the dispatch
    // list. RAII via Leptos's scope.
    store_value(handle);

    // Send the Attach request once the component mounts. The
    // WS connection may not yet be live — the channel buffers
    // the message; the lifecycle task drains it once the
    // handshake completes.
    let session_for_attach = session_id.clone();
    let ws_for_attach = ws.clone();
    create_effect(move |prev: Option<bool>| -> bool {
        // Send Attach exactly once. The prev-value latch
        // mirrors the WS lifecycle's pattern (see
        // `crate::ws::spawn_lifecycle`); this effect doesn't
        // need to react to anything, but `create_effect` is
        // the natural Leptos primitive for "run once at
        // mount."
        if prev.unwrap_or(false) {
            return true;
        }
        ws_for_attach.send(ClientMessage::Attach {
            session: session_for_attach.clone(),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            resume_from_seq: None,
        });
        true
    });

    view! {
        <section id="kat-terminal-tile" data-tile-kind="terminal" data-session=session_id.clone()>
            <h1 class="title">"Terminal"</h1>
            <pre class="terminal-output">{move || buffer.get()}</pre>
        </section>
    }
}
