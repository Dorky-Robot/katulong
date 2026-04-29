//! Dispatch helpers that mutate the layout signal while upholding
//! the layout invariants:
//!   - `order` is a permutation of `tiles.keys()`
//!   - `focused_id` is `None` iff `tiles` is empty; otherwise points
//!     at a key in `tiles`
//!
//! Bare signal writes outside these helpers risk drifting the
//! invariants — call sites should always go through the helpers.
//!
//! Slice 9s.1 only needs `bootstrap_default` (called when the user
//! signs in for the first time, with no persisted layout). Future
//! slices add `add_tile`, `remove_tile`, `reorder`, `focus`, etc.

use katulong_shared::wire::{TileDescriptor, TileId, TileKind, TileLayout};

/// Build a default layout for a fresh signed-in session — one
/// terminal-stub tile and one status tile, with the terminal
/// focused. Used as the seed when no persisted layout exists yet.
///
/// The two-tile shape is a deliberate choice for slice 9s.1: it
/// validates the protocol's polymorphism by exercising both tile
/// kinds in a real layout, even though only one is rendered at a
/// time. When persistence and multi-tile rendering land, this seed
/// becomes "the user's first-ever layout" — which is reasonable as
/// a default UX (terminal-forward, with the connection status
/// available as a separate tile).
pub fn bootstrap_default() -> TileLayout {
    let term_id = TileId("default-terminal".to_string());
    let status_id = TileId("default-status".to_string());

    let mut tiles = std::collections::HashMap::new();
    tiles.insert(
        term_id.clone(),
        TileDescriptor {
            id: term_id.clone(),
            kind: TileKind::Terminal { session_id: None },
        },
    );
    tiles.insert(
        status_id.clone(),
        TileDescriptor {
            id: status_id.clone(),
            kind: TileKind::Status,
        },
    );

    TileLayout {
        tiles,
        order: vec![term_id.clone(), status_id],
        focused_id: Some(term_id),
    }
}
