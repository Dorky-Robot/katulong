//! Terminal tile placeholder. The real WS-attach + xterm rendering
//! lands in a future slice; this version exists so the protocol
//! has a concrete `Terminal` consumer and `<Main/>::SignedIn`
//! has something to render through `<TileHost/>`.
//!
//! The component takes the `session_id` prop so the
//! `TileKind::Terminal { session_id }` props flow through end-to-
//! end. The real terminal slice replaces the body without changing
//! the signature; everything outside this file (the layout signal,
//! the host's match arm, the descriptor wire type) stays put.

use leptos::*;

#[component]
pub fn TerminalTile(#[prop(into)] session_id: Option<String>) -> impl IntoView {
    // `_session_id` is the prop the real terminal slice will read
    // to drive WS attach. Bound (not destructured into `_`) so a
    // grep for `session_id` in this file finds it; reading it via
    // a `let _ =` keeps the compiler from warning about the unused
    // variable today.
    let _ = session_id;

    view! {
        <section id="kat-terminal-tile" data-tile-kind="terminal">
            <h1 class="title">"Signed in"</h1>
            <p class="blurb">"Terminal view lands in a future slice."</p>
        </section>
    }
}
