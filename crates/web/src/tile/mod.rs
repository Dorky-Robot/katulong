//! Tile system — the protocol every UI surface beyond the auth
//! flow rides on. Per `docs/rewrite-tile-protocol.md`:
//!
//! - The layout is a single state atom (`RwSignal<TileLayout>`)
//!   provided at App-root.
//! - `<TileHost/>` reads the layout and renders the focused tile by
//!   matching on `TileKind`. The match is exhaustive — adding a
//!   variant without extending the host is a compile error.
//! - Tiles are descriptors, not objects. A tile's runtime state
//!   (cursor position, scroll offset, etc.) lives inside the tile
//!   component's own signal scope, not the layout atom.
//!
//! This slice (9s.1) lands the protocol foundation + two trivial
//! tile kinds (`Status`, `Terminal` as a placeholder). Future slices
//! add real tile renderers.

pub mod layout;
pub mod status;
pub mod terminal;

use crate::tile::status::StatusTile;
use crate::tile::terminal::TerminalTile;
use katulong_shared::wire::{TileKind, TileLayout};
use leptos::*;

/// The single state atom for the tile layout. Provided at App-root
/// via `provide_context`; consumed by `<TileHost/>` and by dispatch
/// helpers in `crate::tile::layout`.
///
/// `RwSignal` rather than `(ReadSignal, WriteSignal)` because both
/// the host and the dispatch helpers need to read and write — the
/// dispatch helpers in particular often do read-modify-write
/// sequences (e.g., `add_tile` checks if the tile already exists).
/// Splitting the halves would force every dispatch site to thread
/// both signals through context.
#[derive(Copy, Clone)]
pub struct LayoutState(pub RwSignal<TileLayout>);

/// The tile host. Reads the layout signal and renders the focused
/// tile (if any) by matching on its kind.
///
/// Slice 9s.1 renders only the focused tile — multi-tile layout
/// (tab bar, side-by-side) lands in a separate slice. The match
/// covers every `TileKind` variant exhaustively; adding a new kind
/// without extending the host is a compile error.
#[component]
pub fn TileHost() -> impl IntoView {
    let LayoutState(layout) = expect_context::<LayoutState>();

    // Computed: the focused tile's descriptor, or None if no tile is
    // focused (e.g., empty layout). Re-evaluates on layout changes.
    move || {
        let layout = layout.get();
        let focused = layout.focused_id.as_ref().and_then(|id| layout.tiles.get(id));
        match focused {
            None => view! { <EmptyTileHost/> }.into_view(),
            Some(desc) => match &desc.kind {
                TileKind::Status => view! { <StatusTile/> }.into_view(),
                TileKind::Terminal { session_id } => {
                    let session_id = session_id.clone();
                    view! { <TerminalTile session_id=session_id/> }.into_view()
                }
            },
        }
    }
}

/// Rendered when the layout has no focused tile (empty layout, or
/// `focused_id` was just removed). Should not normally appear in
/// practice — the dispatch helpers maintain the invariant that
/// `focused_id` is `Some` whenever the layout is non-empty.
/// Belt-and-braces fallback so we don't panic on an unexpected state.
#[component]
fn EmptyTileHost() -> impl IntoView {
    view! {
        <section id="kat-tile-host-empty" aria-busy="true">
            <p class="blurb">"No tiles yet."</p>
        </section>
    }
}
