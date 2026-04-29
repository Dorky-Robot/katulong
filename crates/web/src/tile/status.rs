//! Status tile. The protocol's second concrete consumer — exists
//! to validate that the host's `match` on `TileKind` is
//! exhaustive across more than one variant, and (when the tab-bar
//! slice lands) to give the user a real connection-status surface.
//!
//! Reads the existing `ConnectionStatus` context (provided at
//! App-root) and renders a tiny status panel.

use crate::ConnectionStatus;
use leptos::*;

#[component]
pub fn StatusTile() -> impl IntoView {
    let ConnectionStatus { connected, .. } = expect_context();
    let label = move || {
        if connected.get() {
            "Connected"
        } else {
            "Disconnected"
        }
    };

    view! {
        <section id="kat-status-tile" data-tile-kind="status">
            <h1 class="title">"Connection status"</h1>
            <p class="blurb">
                {label}
            </p>
        </section>
    }
}
