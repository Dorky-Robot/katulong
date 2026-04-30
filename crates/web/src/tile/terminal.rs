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
//!
//! **FIXME (multi-terminal):** Two terminal tiles with
//! `session_id: None` both resolve to `"main"` and both send
//! `ClientMessage::Attach { session: "main", ... }`. Per the
//! protocol's "one transport binds one session" rule
//! (`katulong_shared::wire`), the second `Attach` re-binds
//! the transport to the same session — both tiles subscribe
//! to the same Output stream and effectively mirror each
//! other. The bootstrap layout has only one terminal tile so
//! this isn't a current bug, but the persistence / multi-tile
//! slice MUST populate `session_id` with a stable per-tile id
//! before adding a second terminal tile to the layout, or the
//! tiles will collide silently.

use crate::ws::WsClient;
use katulong_shared::wire::{ClientMessage, ServerMessage};
use leptos::*;
use wasm_bindgen_futures::spawn_local;

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
    //
    // **Lossy decode caveat.** `String::from_utf8_lossy` is
    // applied per-chunk: if a multi-byte UTF-8 char (e.g., a
    // 4-byte emoji) splits across two `Output` chunks, EACH
    // half is replaced with `U+FFFD` and the original code
    // point is lost — not "robust degradation", outright loss.
    // The lossy path is acceptable for a placeholder slice
    // (xterm in 9s.4 replaces this with a stateful byte-stream
    // writer that buffers incomplete sequences); it must NOT
    // be carried forward into the xterm slice as an
    // approximation. The 9s.4 cutover should replace the
    // signal type entirely (`String` → raw `Vec<u8>` piped
    // straight to xterm.write).
    let handle = ws.subscribe(move |msg| {
        if let ServerMessage::Output { data, .. } = msg {
            let s = String::from_utf8_lossy(data).to_string();
            buffer.update(|buf| buf.push_str(&s));
        }
    });

    // Keep the subscriber handle alive for the component's
    // lifetime. `store_value` ties it to the component scope;
    // when the tile unmounts (e.g., layout changes focus
    // away in a future multi-tile slice), the handle drops
    // and `Drop` removes the subscriber from the dispatch
    // list. RAII via Leptos's scope.
    store_value(handle);

    // Send `Attach` exactly once at mount. `spawn_local` is
    // the right primitive for "run a future once when the
    // component is placed in the tree" — it cannot
    // accidentally re-run, unlike `create_effect`'s
    // signal-tracking mechanism (`create_effect` would also
    // work today because the closure reads no signals, but a
    // future maintainer who adds a reactive read would
    // silently break the once-only semantics).
    //
    // The future itself is synchronous — `WsClient::send`
    // returns immediately — but `spawn_local` is the
    // language-level signal that this is a side-effect at
    // mount, not a reactive subscription.
    spawn_local({
        let ws = ws.clone();
        let session = session_id.clone();
        async move {
            ws.send(ClientMessage::Attach {
                session,
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                resume_from_seq: None,
            });
        }
    });

    view! {
        // `data-session` exposes the bound session id for
        // operator devtools (one-line `document.querySelector`
        // to inspect which tile is attached where) and as a
        // selector hook for any future per-tile e2e test.
        // No CSS rule depends on it today; remove if a future
        // slice clearly doesn't need it.
        <section
            id="kat-terminal-tile"
            data-tile-kind="terminal"
            data-session=session_id.clone()
        >
            <h1 class="title">"Terminal"</h1>
            // **XSS-safety note.** Leptos's `view!` macro
            // inserts `String` values as DOM text nodes (via
            // `createTextNode` / `textContent`), NOT as
            // `innerHTML`. Server-controlled bytes flowing
            // through the buffer cannot inject markup here; a
            // shell command running `echo '<script>...'`
            // produces literal visible characters. Do NOT
            // switch this binding to `inner_html()` or
            // similar — that would turn the PTY-output path
            // into a stored-XSS surface.
            <pre class="terminal-output">{move || buffer.get()}</pre>
        </section>
    }
}
