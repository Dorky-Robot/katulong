# Rust rewrite — tile protocol

This doc names the contract that every tile renderer implements in
the Leptos frontend. Future slices add concrete tile kinds
(terminal, Claude feed, file-browser, notes, etc.) by extending the
protocol rather than reinventing the host.

It's the Rust counterpart to `docs/tile-state-rewrite.md` (which
documents the Node tile system's first principles). The principles
carry over wholesale — only the implementation language changes.

## First principles (carried from the Node doc)

1. **One state atom.** Exactly one Leptos signal describes the
   layout: which tiles exist, what order they're in, which one is
   focused. Persistence (when it lands) writes through this signal;
   nothing reads "the truth" from anywhere else.
2. **Render is a pure function of state.** `<TileHost/>` reads the
   layout signal and matches on `TileKind` to render the right tile
   component. No imperative `mount`/`unmount`/`focus`/`blur` calls
   from the host — Leptos's reactive runtime handles
   mount/unmount automatically when the descriptor changes.
3. **Tiles are descriptors, not objects.** A tile is a plain
   `TileDescriptor { id, props }` record where `props` is a
   `TileKind` enum variant carrying that tile's typed
   configuration. The tile's *runtime* state (cursor position,
   scroll offset, current cwd, etc.) lives inside the tile
   component's own signal scope, not the layout atom.
4. **URL `?s=` is a boot hint, not live state.** Read once at App
   mount, dispatched as a "focus this tile if it exists" action
   into the layout signal. After boot, the URL is *written from*
   layout state for bookmarkability — never read back as truth.
5. **Sessions stay decoupled.** A `TileKind::Terminal { session_id
   }` references a tmux session by id. The session manager owns
   PTY lifecycle; the tile is purely a viewport. Multiple terminal
   tiles can reference the same session — a property the Node side
   already supports.

## Why these principles matter for the rewrite

The Node implementation arrived at this shape through scar tissue:
three sources of truth (carousel, windowTabSet, sessionStore) drifting
on every mutation, each fix another manual sync call. The Rust rewrite
lands in a system that already paid that lesson — Leptos signals + a
single layout atom give us "render is a pure function of state" by
construction, not by discipline.

Diwa-surfaced architectural rules that bind the design:

- **Per-tile state, not module-level singletons** (commit `545b110`).
  Two file-browser tiles must not share navigation state; serialize
  must emit each tile's own cwd. In Leptos terms: each tile component
  creates its own signals with `create_signal` *inside* its component
  body, not at module scope.
- **State machines with callback injection** (commit `8616157`).
  Pure state machines + thin shells. The tile registry (mapping
  `TileKind` → component) is the seam; the host is a pure render of
  the layout signal.
- **Generic tile system obsoletes special overlays** (commit
  `9868545`). The helm overlay was deleted in favor of "any content
  lives in a tile." The Rust rewrite never builds a special overlay —
  every UI surface beyond the auth flow is a tile from day one.
- **Cluster tiles need explicit recursion** (commit `7fa1e22`). When
  the cluster variant lands, it carries `sub_tiles: Vec<TileId>` and
  the host renders sub-tiles inside the cluster's own slot. Code that
  iterates tiles for session-level operations must walk
  `getSubTiles()` for clusters — the Rust shape captures this in the
  type (cluster has a different data shape than leaf tiles, so any
  match on `TileKind` is forced to handle it).

## The wire shape

Lives flat in `katulong_shared::wire` alongside the existing auth
wire types. A future slice may split `wire.rs` into submodules
(`wire/auth.rs`, `wire/tiles.rs`) when the file grows large enough
to justify the restructure; today it's small enough to stay flat.

```rust
// katulong_shared::wire

/// Stable identifier for a tile instance. UUID-ish.
pub struct TileId(pub String);

/// What kind of tile, plus the typed props for that kind.
/// Each variant's data shape is enforced at the type level — adding
/// a new field to a kind's props doesn't risk drifting because every
/// match site updates in lockstep.
pub enum TileKind {
    /// A connection-status indicator. Trivial — exists in slice 9s.1
    /// to validate the protocol with two consumers.
    Status,
    /// A terminal viewport for a tmux session. Slice 9s.1 lands the
    /// stub variant; the real WS-attach + xterm-style rendering
    /// arrives in a later slice.
    Terminal { session_id: Option<String> },
    // Future variants (one per slice that lands the kind):
    //   Cluster { sub_tiles: Vec<TileId> },
    //   FileBrowser { cwd: String },
    //   Document { source: DocumentSource },
    //   ClaudeFeed { ... },
    //   Notes { name: String },
    //   etc.
}

pub struct TileDescriptor {
    pub id: TileId,
    pub kind: TileKind,
}

pub struct TileLayout {
    pub tiles: HashMap<TileId, TileDescriptor>,
    pub order: Vec<TileId>,           // permutation of tiles.keys()
    pub focused_id: Option<TileId>,    // None when no tiles
}
```

Invariants enforced by construction:

- `order` is a permutation of `tiles.keys()`. Inserts/removes maintain
  this; no operation can leave an orphan.
- `focused_id` is `None` when `tiles` is empty, otherwise points to a
  key in `tiles`.
- Tile mutation is always through dispatch helpers (`add_tile`,
  `remove_tile`, `focus_tile`, `reorder`) that uphold the invariants
  — not through bare signal writes.

## Component contract

```rust
// crates/web/src/tile/mod.rs

#[component]
pub fn TileHost() -> impl IntoView {
    let layout = expect_context::<RwSignal<TileLayout>>();
    // Render the focused tile by matching on its kind. `<For>` over
    // multiple visible tiles comes in the multi-tile-layout slice;
    // for now the host renders only the focused one.
    view! { ... match focused.kind { TileKind::Status => <StatusTile/>,
                                       TileKind::Terminal { .. } => <TerminalTile/>, } }
}
```

Each tile component:

- Reads its own props from layout (via `tile_id` prop or context)
- Owns its internal state (signals created inside the component body)
- Subscribes to whatever it needs (server topics, WS messages,
  global state) — but does NOT write back into the layout atom for
  internal updates. Layout writes are reserved for cross-tile
  concerns (focus, ordering, tile add/remove).

## Persistence strategy (deferred to a follow-up slice)

`TileLayout` derives `Serialize + Deserialize` so it can round-trip
to JSON for localStorage or to the server's auth-state-style
persistence layer. This slice does NOT wire the persistence; it only
ensures the descriptor types are serializable so the persistence
slice doesn't have to refactor the protocol.

Two separable concerns when persistence lands:

1. **Where** — localStorage (per-browser) vs server-side per-user
   layout. Node uses localStorage; the Rust rewrite may follow or
   may move it server-side.
2. **What** — full `TileLayout` (including focus + order) or
   structural-only (which tiles exist, leave focus to URL `?s=`)?
   Decision belongs to the persistence slice.

## Mapping to existing Node tile kinds

The Node implementation has 9 renderers today. Each becomes a Rust
slice that adds a `TileKind` variant + the corresponding component:

| Node renderer | Future Rust slice | TileKind variant |
|---|---|---|
| `terminal` | next major | `Terminal { session_id }` (real, not stub) |
| `cluster` | post-terminal | `Cluster { sub_tiles }` |
| `feed` (Claude events) | post-topic-broker | `ClaudeFeed { agent_id }` |
| `file-browser` | UX | `FileBrowser { cwd }` |
| `document` | UX | `Document { source }` |
| `localhost-browser` (port proxy) | UX | `LocalhostBrowser { port }` |
| `progress` | UX | `Progress { task_id }` |
| `image` | UX | `Image { source }` |
| `history` | UX | `History { session_id }` |

Slice 9s.1 doesn't land any of these — it lands `Status` (trivial,
exists only to validate the protocol with two consumers) and
`Terminal` as a stub (so `<Main/>::SignedIn` has something to render
through `<TileHost/>`).

## Open questions for future slices

- **Tab bar UI.** The Node side has a substantial tab-bar component
  (`tile-tab-bar.js`, 568 lines) with reordering, renaming, badges.
  The Rust rewrite needs an equivalent slice; this design doc's
  scope is the data layer, not the chrome.
- **Cluster tile recursion.** Sub-tiles complicate the layout shape —
  is `tiles` a flat map with cluster tiles holding `Vec<TileId>`, or
  does the layout become tree-shaped? Defer the decision to the
  cluster-tile slice; the protocol as designed is flat.
- **Tile-to-tile communication.** Today every tile is independent.
  If a future feature needs cross-tile messaging (e.g., Claude feed
  triggering a terminal action), this slice's design has no answer —
  add it as a separate primitive (event bus or topic broker) rather
  than coupling tiles.
- **Persistence schema versioning.** `TileLayout` doesn't carry a
  version field today; the persistence slice should add one and
  decide migration semantics before the schema sees real users.
