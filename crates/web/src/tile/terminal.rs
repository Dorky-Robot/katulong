//! Terminal tile. Slice 9s.1 ships the placeholder shape: the
//! component renders a "Signed in" stub with a blurb noting where
//! the real terminal view lands. The component takes a
//! `session_id: Option<String>` prop so the descriptor's typed
//! props flow through, even though nothing is wired yet.
//!
//! When the real terminal slice lands, this component grows the WS
//! attach + xterm-style rendering. Everything outside this file
//! (the layout signal, the host's match arm, the descriptor wire
//! type) stays as-is — that's the value of getting the protocol
//! shape right first.

use leptos::*;

#[component]
pub fn TerminalTile(#[prop(into)] session_id: Option<String>) -> impl IntoView {
    // Hold session_id in a derived computation so a future slice
    // that switches on attached/unattached doesn't have to re-shape
    // the component signature. Today both branches render the same
    // stub copy — but having the branch present documents the shape.
    let attached = session_id.is_some();

    view! {
        <section id="kat-terminal-tile" data-tile-kind="terminal">
            <h1 class="title">"Signed in"</h1>
            <p class="blurb">
                {if attached {
                    "Terminal view lands in a future slice — session attached."
                } else {
                    "Terminal view lands in a future slice."
                }}
            </p>
        </section>
    }
}
