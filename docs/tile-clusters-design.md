# Tile Clusters — Design Notes

Living design doc for the tile-cluster / virtual-desktop UX. Captured from a brainstorming session so subagents can pick up individual iterations without losing the high-level model. Update as decisions evolve.

## Core mental model

- **Cluster = virtual desktop.** A cluster is a *container of tiles*, not a tile itself. Each cluster is its own independent workspace, like a macOS Space.
- **Tiles** are the existing terminal tiles. They live inside a cluster.
- **The `+` button on the tile bar creates a new terminal in the current cluster.** No "New Cluster" option there. Cluster create/manage lives in the zoomed-out view.
- The carousel-of-tiles UI we have today is *one view mode of one cluster*. Everything below extends from there.

## Spatial model

A cluster is a **2D grid of tiles**, not a 1D carousel. Today's UI happens
to be 1D because every column has exactly one tile; the grid is the real
shape, and Level 2 is the view that makes that shape visible.

### A cluster is a 2D tile grid

```
Today (1 row, N columns — the existing carousel):

         ┌────┐ ┌────┐ ┌────┐ ┌────┐
         │ A  │ │ B  │ │ C  │ │ D  │
         └────┘ └────┘ └────┘ └────┘

Tomorrow (N rows per column, each column scrolls independently).
Every column has a "focused row" tile that is what you see when
that column is centered in the viewport. Other rows exist above
and below and come into view on Option+↑/↓:

                ┌────┐                         ┌────┐
                │ F  │                         │ G  │    ← rows above focus
                └────┘                         └────┘
         ┌────┐ ┌────┐ ┌────┐ ┌────┐
         │ A  │ │ B  │ │ C  │ │ D  │                    ← focused row
         └────┘ └────┘ └────┘ └────┘
                ┌────┐        ┌────┐
                │ H  │        │ I  │                    ← rows below focus
                └────┘        └────┘
                ┌────┐
                │ J  │
                └────┘
```

Position IS identity (see MC1 / v3 state shape). A tile at `clusters[c][col][row]`
has no `x`/`y` fields — its coordinates are where it lives in the array.

### Navigation pans the viewport across the grid

**Horizontal pan** (Level 1 today): moves between columns.

```
     viewport                         viewport
    ┌─────────┐                      ┌─────────┐
    │ ┌──┐ ┌──│┐  ┌──┐ ┌──┐          │┌──┐ ┌──┐│ ┌──┐
    │ │ A│ │ B││  │ C│ │ D│   →      ││ B│ │ C││ │ D│
    │ └──┘ └──│┘  └──┘ └──┘          │└──┘ └──┘│ └──┘
    └─────────┘                      └─────────┘
       A focused                        B focused
```

**Vertical pan** (MC tier): moves between rows within a column. Each
column scrolls independently — the viewport stays put and the column
slides under it, bringing a new row-tile into the focused slot. Tiles
do not cycle; they just scroll out of view. Sibling columns are
unaffected (column A below stays where it is when column B scrolls).

```
    before                           after Option+↓ (on column B)

              ┌────┐                           ┌────┐
              │ F  │                           │ F  │  ← above, unchanged
              └────┘                           └────┘
                                               ┌────┐
                                               │ B  │  ← scrolled above viewport
                                               └────┘
    ╒═══════════════════╕            ╒═══════════════════╕
    │ ┌────┐   ┌────┐   │            │ ┌────┐   ┌────┐   │
    │ │ A  │   │ B  │   │ viewport   │ │ A  │   │ H  │   │ viewport
    │ └────┘   └────┘   │            │ └────┘   └────┘   │
    ╘═══════════════════╛            ╘═══════════════════╛
              ┌────┐                           ┌────┐
              │ H  │                           │ J  │
              └────┘                           └────┘
              ┌────┐
              │ J  │
              └────┘
```

Column A has one tile so it can't scroll. Column B scrolled up by one
row: F (which was above) stays above, B (the previously focused tile)
is now above the viewport, H slides into the focused slot, J remains
below. Option+↑ reverses the motion.

### Level 2 compresses Y so multiple clusters fit vertically

At Level 2 we collapse each column's tiles into a **deck of cards** so
the cluster reduces to a single row. The deck is a Level-2 render
trick, not a working mode — you can't edit or type into a deck; it's a
view of the column's contents.

**The deck preserves the column's Y arrangement, exactly.** If a
column reads [F, B, H, J] from top to bottom with B in the focused
row, every tile keeps its original Y offset from the focus: F stays
above B, H and J stay below. The focused tile is the anchor — not
pulled to the front, not flattened into a stack.

**What compresses is Z, not Y.** The column tilts forward around a
horizontal axis at the focus, so distance-from-focus along Y becomes
distance-from-focus along Z. Tiles below the focus swing down-and-
forward (closer to the viewer); tiles above recede up-and-back.

**The viewpoint is axonometric** (orthographic, angled — not head-on).
That tilt is what makes every card visible at once: you see the full
column tipped toward you, not a single face-on rectangle hiding the
rest. Pinch-in is the inverse — the column rotates back upright into
the 2D grid, with the same row focused.

```
 Column B at Level 1                 Column B as Level 2 deck
 (F, B, H, J top-to-bottom;          (column tilted forward, viewed
  B in the focused row)               axonometrically — Y preserved,
                                      Z added from the tilt)

     ┌────┐                                 ┌────┐
     │ F  │                                 │ F  │        ← above focus:
     └────┘                                 └────┘          up-and-back
     ┌────┐                                ┌────┐
     │ B  │ ← focus                        │ B  │ ← focus (anchor, z=0
     └────┘                                └────┘           on the focus axis)
     ┌────┐                               ┌────┐
     │ H  │                               │ H  │
     └────┘                               └────┘
     ┌────┐                              ┌────┐
     │ J  │                              │ J  │          ← far below focus:
     └────┘                              └────┘            down-and-forward
                                                           (closest to viewer)
```

The leftward shift per row in the deck indicates Z progression: the
further a tile sat from the focus in the column, the further it swings
in Z under the tilt. Above-focus tiles recede (up and back); below-
focus tiles advance (down and toward the viewer). A single-tile column
is a deck of one — no tilt needed, it's just the tile itself.

Tilting columns this way is what makes it possible to show *multiple*
clusters at once as a vertical stack of horizontal strips:

Level 1 — one cluster, 2D grid visible (focused row marked). Only
column B has tiles outside the focused row (F above, H and J below);
columns A, C, D are single-tile:

```
                ┌────┐
                │ F  │
                └────┘
         ┌────┐ ┌────┐ ┌────┐ ┌────┐
         │ A  │ │ B  │ │ C  │ │ D  │   ← focused row
         └────┘ └────┘ └────┘ └────┘
                ┌────┐
                │ H  │
                └────┘
                ┌────┐
                │ J  │
                └────┘
```

Pinch out → Level 2. The 2D grid of every cluster collapses into a row
of decks, and all clusters stack vertically:

```
  ╔═ cluster 0 (the one shown above) ═════════════════════╗
  ║            [F]                                        ║   ← F up-and-back
  ║   [A]     [B] ← focus   [C]   [D]                     ║   ← focus row
  ║          [H]                                          ║
  ║         [J]                                           ║   ← J down-forward
  ╚═══════════════════════════════════════════════════════╝
  ╔═ cluster 1 ═══════════════════════════════════════════╗
  ║   [M]    [N]    [O]                                   ║
  ╚═══════════════════════════════════════════════════════╝
  ╔═ cluster 2 ═══════════════════════════════════════════╗
  ║   [P]    [Q]    [R]    [S]    [T]                     ║
  ╚═══════════════════════════════════════════════════════╝
```

Column B's deck keeps F above the focus row and H/J below it — the
Y-arrangement of the original column. The small leftward shift per row
reads as Z: F is farther back, J is farther forward, B sits at the
anchor. Single-tile columns (A, C, D, M, N, …) have no tilt — they're
just the tile itself at the focused row.

**Why "compress Y, don't compress X":** a horizontal strip of clusters
that each spread vertically would be unreadable — you'd lose the
cluster-strip metaphor. Compressing Y into decks keeps every cluster
shaped like a row, so rows stack cleanly.

## Zoom levels

There are two zoom levels, navigated by **pinch**. There is no per-cluster
"view mode" — L1 is always the carousel; L2 is always the tilted-deck
strips.

### Level 1 — Focused carousel (current default)
Single cluster fills the screen, rendered as a 1D horizontal axis of
**columns** (see "Columns" below). One column is focused; neighbors
peek. Multi-row columns scroll vertically within the focus slot
(Option+↑/↓). This is the existing behavior, generalized by the
Spatial-model rules above.

### Level 2 — Cluster overview
Pinch out from Level 1. You see **all clusters as a vertical stack of horizontal strips**. Think: multiple stacked copies of <https://auto-replicating-draggable-carousel.webflow.io/>, each strip scrollable horizontally and independently. Each column in a strip renders as a tilted deck per the Spatial-model rules.

- **Vertical scroll** moves between cluster strips.
- **`+` button** at this level creates a new cluster. Position TBD.
- **Tap a cluster (or pinch in)** to zoom back into Level 1 on that cluster.

### Level 3 — Spatial canvas (parked)
Maybe a freeform 2D canvas like the Cosmic / Stage Manager screenshots — clusters placed at xy positions, pan-and-zoom. Iterate on this once Level 2 is alive. **Not in scope yet.**

## Columns (vertical stacking within a carousel slot)

Carousel x-slots are not "one tile fills the viewport." Each x-slot is a **column** that may contain 1..N tiles.

- **Default**: 1 tile per column. Existing behavior.
- **Stacking**: drag tile B onto tile A → column of two. Drag tile B back out → its own column again. **Stacking is a drag verb, not a "split" button.** No menu, no mode switch.
- **Resize**: same edge-handle pattern as today's left/right column-width handles, mirrored on top/bottom for tile-height-within-column. Symmetric.
- **Sane default / min / max**: same pattern as horizontal sizing today. Default = sensible split. Min = some floor. Max = viewport.
- **Vertical scroll within a column** when total tile heights exceed viewport. Each column scrolls independently. Same behavior as horizontal carousel scroll, rotated 90°.
- **A single tile can be taller than the viewport** if the user resizes it that way; the column scrolls to expose the rest. (Mirrors the horizontal "tile can be wider than viewport" affordance.)
- **Anti-pattern**: the macOS Terminal.app vertical-split behavior where each split shrinks all siblings into uselessness. We explicitly do not want that.

### Drag-to-stack collision target (decision pending, leaning)
- **Center of target tile** = stack into this column.
- **Left/right edges of target tile** = insert as new column on that side.
- Visual highlight on the drop zone as you hover.
- Lets drag-to-reorder and drag-to-stack coexist unambiguously.

### Active tile / focus navigation
- Each column has its own active tile (the one keystrokes go to).
- **Option+↑ / Option+↓** moves focus within a column (vertical analogue of how horizontal arrows snap-to-active across columns).
- **Option+←/→** for column navigation (add for symmetry if not already present).
- Focus snap = scroll the column so the active tile is in view.

### Level 2 rendering of stacked columns
At Level 2 every column — whether it has one tile or many — renders
per the Spatial-model rules: the column tilts forward around its
focused row, and above/below-focus tiles stagger in Y and Z under the
axonometric view. A 1-tile column is a deck of one (no tilt). No
separate "thumbnail" or "deck of cards in exposé" treatment — there
is only the L2 tilted-column render.

## Pinch gesture

- **Pinch is the zoom verb.** Pinch out = zoom out (Level 1 → Level 2). Pinch in = zoom in. Pinch has no other meaning — there is no mode-switch verb to share it with.
- **Trackpad pinch on desktop** arrives as `wheel` events with `ctrlKey` set. Support both touch and trackpad from day one so dev iteration is possible on the Mac mini.
- Greenfield in the codebase as far as we know — verify before implementing. If greenfield, raw pointer events with two-pointer tracking, no gesture lib.

## File browser as a tile

> **Status:** The /consult review revealed PR #533 already converted the file browser from a fullscreen overlay into a real tile (`public/lib/tiles/file-browser-tile.js`). What remains is captured below; most of it is absorbed into **T1b** in the build order.

- **Multi-instance**: clicking the folder button on terminal A and then on terminal B creates **two independent file browser tiles**. Not one that jumps around. Today `openFileBrowserTile` in `app.js` has a singleton guard that focuses an existing FB tile; delete it.
- **Spawn position**: a new file browser tile appears as a **new column immediately to the LEFT of the spawning terminal**, pushing earlier columns over. Matches the Finder mental model (file list on the left, terminal on the right).
- **cwd inheritance**: the new file browser opens at the spawning terminal's current working directory.
- **Repeat click**: each click on a terminal's folder button creates a **new** file browser tile. No reuse-if-exists.
- **Lifetime**: once created, a file browser tile is independent of its spawning terminal. Closing the terminal does not close the file browser.
- **Sized like a tile**, not a sidebar. Participates in carousel scroll, column resize, drag-to-stack, and the L2 tilted-deck render like any terminal tile.
- **Component root-class collision**: `file-browser-component.js` currently clobbers its container's className, forcing `file-browser-tile.js` to wrap it in an extra `<div>`. Fix the component so it owns a child (e.g. `.fb-root`) rather than stamping on its parent's class.

Note: the `#sidebar` element in `index.html` is the **session-list launcher**, *not* the file browser — do not conflate it with this work.

## Future input modes (parked, not in scope)

Discussed but explicitly deferred until pinch + Level 1/2 are working:

- **Multi-touch**: two-finger swipe between clusters, three-finger gestures, long-press-drag to rearrange tiles at Level 2.
- **Gyro**: ambient parallax, peek at neighbors, tilt-to-switch.
- **Camera tracking**: face-tracking like the felixflor.es experiment. Aesthetic / "feels alive", or load-bearing (look-away-to-blur for shoulder-surfing protection). Permission/battery/privacy cost is real — treat as separate experiment.

## Build order

**Step 1 (landed, `edf8c88`) — exposé morph removed in `53b63d4`.**
Originally landed pinch gesture plumbing (touch + trackpad `wheel`+`ctrlKey`)
*plus* a carousel↔exposé morph via same-DOM FLIP. Exposé was cut from
scope — L1 is carousel-only, L2 is the overview — and the morph code
was removed alongside FP4's pinch reducer. The pinch-gesture plumbing
(`public/lib/pinch-gesture.js`) stayed, waiting for MC3 to re-attach it
to an L1↔L2 toggle.

Everything after Step 1 follows the **Tier 1 / Tier 2 / Tier 3** plan in "Architectural decisions" below — a refactor lands *before* the new features so columns, file-browser-as-tile, and Level 2 build on a clean substrate instead of bolting onto the flat-array model.

### FP pre-req for multi-cluster (2026-04-13)

Before the multi-cluster substrate lands, the imperative chunks of `app.js` that multi-cluster will touch get converted into the established reducer/factory/effect-descriptor pattern (campaign history: `28f5538`, `29d6ec6`, `9868545`, `d9357ba`). Rationale: imperative state plus a new cluster layer produces hard-to-debug bugs; the conversion pays itself back in debuggability.

**Scope is the critical path only.** WebRTC retry, iframe focus, connection-indicator tooltip, settings handlers, and other still-imperative chunks are orthogonal and stay deferred.

Pre-req checklist (convert before multi-cluster strips):
- [x] **FP1 — Carousel persistence reducer** (`33aa3be`). v2 ui-store shape `{ version, activeClusterId, clusters, tiles (with clusterId), focusedIdByCluster }`; extracted `buildBootState()` to a pure module with legacy v1→v2 migration. *Medium.*
- [x] **FP2 — Cluster activation cleanup** (`509da16`). Removed last imperative `carousel.isActive() ? carousel.getCards() : windowTabSet.getTabs()` branch in `pickRightNeighbor`; reads ui-store `state.order`/`focusedId` directly. (SWITCH_CLUSTER action landed in FP1; cluster-switch *effect* designed alongside MC3 when there's a caller.) *Small.*
- [x] **FP3 — `+` button routing factory** (`668a450`). New `public/lib/add-target.js`: pure `decideAddTarget({level, activeClusterId, focusedId})` + `createAddHandler` factory + id generators. Sidebar-+ rewired through factory; level-2 path wired to `uiStore.addCluster` so MC3 only swaps `getLevel()`. 12 pure tests. *Small.*
- [x] **FP4 — Pinch level reducer** (`3cb0138`, *reverted as part of exposé removal*). Originally shipped `public/lib/pinch-levels.js` with a pure `reducePinch` for L1-carousel↔L1-expose↔L2. When exposé was dropped from the design, the 3-state reducer collapsed to a simple L1↔L2 toggle that doesn't need a reducer; `pinch-levels.js` and its 17 tests were deleted. MC3 will wire `pinch-gesture.js` directly to a level toggle. *Medium.*
- [x] **FP5 — Carousel↔cluster isolation** (`d39a96b`). New `selectClusterView(state, clusterId)` selector; tile-host accepts optional `getClusterId` (defaults to active cluster) and reconciles via the scoped view; `syncCarouselSubscriptions(clusterId?)` iterates ui-store order instead of carousel cards. 12 new selector tests. *Medium.*

Then the multi-cluster work itself (each line below is a separate PR on top of the pre-req):
- [x] **MC1 — T2a columns data shape** (shipped as PR #580 — v3 3D `clusters[c][col][row]` array, position IS identity).
- [x] **Exposé removal** (`53b63d4`, PR #583). Deleted `setMode`/`getMode`/`positionExpose`/`computeExposeCells` from `card-carousel.js`, the pinch-wiring block from `app.js`, and `public/lib/pinch-levels.js` + its 17 tests. `pinch-gesture.js` kept for MC3 to re-attach. *Small.*

### MC1b–MC1e — alignment-debt stabilization pass (2026-04-14)

MC1 landed the 3D state shape, but callers from the Step-1 / pre-FP era still reach into `card-carousel` imperatively instead of projecting from `uiStore`. Before MC3 layers L2 decks on top, the substrate is stabilized through a series of small, independently-landable refactors. Each pass is scoped to a single concern so heavy-flux reviews stay tractable and agents working in parallel don't stomp each other.

Rationale for splitting vs. one big "MC1b": **carousel API shrinkage can only happen once the last reader stops calling it.** That creates a natural sequence (fix bugs → decouple consumers one-at-a-time → delete dead exports → optional persistence migration). Each pass also carries doc-sync for any lines it touches — no separate doc-only PR.

Originally MC2 was scoped as a "layout-change snapshot" emitted from carousel that shortcut-bar would cache. That framing is wrong under the FP1–FP5 model: a snapshot cache in shortcut-bar would be a second source of truth next to `uiStore`. Correct framing — shortcut-bar is a projection of `uiStore`, same pattern `tile-host.js` already uses. "MC2" is therefore dissolved into MC1c/MC1d below.

- [x] **MC1b — File-browser v2 coordinate fix.** Replaced the broken `thisTile.x + 1` / `t.x === rightX` scan with `findAdjacentPreviewToSwap(state, browserId)` — a pure helper that uses `tileLocator` to find the file-browser's path and reads `clusters[c][col + 1][0]` directly under v3. Exported for tests; invoked from `onFileOpen`. Added `test/file-browser-renderer.test.js` with 7 cases: document neighbor, image neighbor, non-preview neighbor, last-column, missing id, cross-cluster isolation, open-twice regression.

- [ ] **MC1c — shortcut-bar as `uiStore` projection.** Drop the `carousel` import from `public/lib/shortcut-bar.js`; take `uiStore` as a dep; subscribe via `uiStore.subscribe(listener)` (same pattern `tile-host.js` uses). Mapping of current carousel reads → store projections: `carousel.getCards()` → `selectClusterView(state, c).order`; `carousel.getTile(id)` → `state.tiles[id]` (or `tileLocator`); `carousel.getFocusedCard()` → `selectClusterView(state, c).focusedId`; `carousel.isActive()` → derived `order.length > 0` (or hoist to `selectHasActiveCluster`). Mutations: `carousel.reorderCards(order)` → dispatch `REORDER_TILES`; `carousel.removeCard(id)` → dispatch `REMOVE_TILE`. Verify these actions exist in `ui-store.js`; add any missing (with tests) as part of this pass. Rebuild-on-state-change replaces event-driven imperative updates. Delete any carousel exports that *only* shortcut-bar consumed. *Template pass — MC1d mirrors this pattern for app.js.* *Medium.*

- [ ] **MC1d — app.js as `uiStore` projection + final carousel shrinkage.** Same reframe as MC1c for any state reads `public/app.js` still does against carousel. Carousel calls from app.js stay only for imperative DOM commands (`activate`, `deactivate`). After this lands, delete the remaining dead exports from `card-carousel.js` — carousel's contract becomes: receives commands, emits nothing, exposes no state reads. *Sequenced after MC1c so the same PR that ends the last reader also ends the dead exports.* *Medium.*

- [ ] **MC1e — Persistence to `uiStore`** *(optional, deferrable past MC3).* Move `save`/`restore` out of `card-carousel.js` into the ui-store layer. `MAX_PERSISTED_CARDS = 50` becomes a per-cluster cap (falls out naturally once each cluster's tiles are persisted from `clusters[c]`). Bumps localStorage schema (v3 → v4) with a migration. Flagged optional because it changes storage format and should not stack on top of in-flight refactors — ship after MC1d stabilizes, or after MC3 if schedule demands. *Medium (the migration is the risk, not the code).*

Then the feature work:
- [ ] **MC3 — Level 2 cluster strips** (vertical stack of horizontal carousel strips, pinch-out from Level 1, tilted-deck rendering per Spatial model, `+` at Level 2, tap/pinch-in to return). Needs per-column focused-row state (schema design during MC1c/d); deck rendering primitive extracted for reuse; re-wires `pinch-gesture.js` to the L1↔L2 toggle.

Explicitly deferred from this round: T1a (flip extraction) — *shipped via `ctx.faceStack`, see "Architectural decisions" §1 below*; T1b (file-browser polish beyond the MC1b bug-fix); T2c (face-stack-of-N, now only used by L2 decks); drag-to-stack; columns with >1 tile; Level 3 spatial canvas.

## Architectural decisions (from /consult, 2026-04-09)

The /consult agent revealed the file browser is *already* a tile (PR #533). The real structural problems are in the **container** (`card-carousel.js`), not the content. Recorded decisions:

1. **Auto-flip-on-idle stays load-bearing.** `ctx.faceStack` (the new abstraction replacing `setBackTile`/`flipCard`/`isFlipped`) must be observable from inside a tile so terminal-tile can keep driving its own flip-on-idle without reaching `deps.carousel`.
2. **`cluster-tile.js` is extracted, not deleted.** The reusable primitive is a **tile container** — the same abstraction used by Level 1 carousel, Level 2 cluster overview, and existing composite tiles (`cluster-tile`, `crew-tile` from `da66182`). `cluster-tile` becomes a thin wrapper that mounts a container inside itself. One implementation, three use sites. Prior history: `9f58df9` introduced the generic tile container, `816cf08` added a plugin SDK / manifest discovery, PR #533 deliberately killed the SDK and registry. This extract is *internal* and **must not** re-introduce a plugin SDK, manifest discovery, or extensibility surface — all tile types remain in-tree.
3. **Persistence is per-cluster.** `MAX_PERSISTED_CARDS = 50` becomes a per-cluster cap. Storage schema bumps to a workspace shape: `{ clusters: [{ id, columns, ... }], activeClusterId }`.
4. **No tab bar at Level 2.** The shortcut/tab bar belongs to Level 1 only. Level 2 navigates via the cluster strips themselves (and pinch-in to return). The `onLayoutChange` snapshot contract from T2b only feeds Level 1.
5. **Plugin SDK stays dead.** PR #533's deletion stands. `TileContext` is an *internal* contract, not a stability boundary, and can change as the team needs.

### Build order (revised by consult)

The original Step 1.5 / 1.6 order is replaced with a three-tier plan that lands a refactor *before* the new features:

- **Tier 1 (small, ~1 day):**
  - **T1a** — move flip off the carousel surface; `terminal-tile` calls `ctx.faceStack` instead of `deps.carousel`. Delete the lazy-getter circular wiring.
  - **T1b** — fix `file-browser-component` root-class collision, drop the inner-div wrapper, delete the singleton guard in `openFileBrowserTile`. Step 1.6 essentially done after this.
- **Tier 2 (large, 2–4 days, one PR):**
  - **T2a** — `cards: string[]` → `columns: Array<Column>` with single-slot columns initially. Pure data-shape change, behavior identical, persistence migrates legacy.
  - **T2b** — carousel emits `onLayoutChange` snapshot; shortcut-bar consumes it, stops importing carousel directly. Kills the dual-source-of-truth nerve that bit `4285396`/`48b48b2`.
  - **T2c** — face-stack of N; current 2-face flip becomes the n=2 case. Same primitive supports the L2 tilted-deck render.
- **Tier 3 — features on top of the new substrate:**
  - Step 1.5 (columns / drag-to-stack)
  - Step 1.6 polish (the few remaining file-browser-as-tile bits not covered by T1b)
  - Step 2 (Level 2 cluster overview, no tab bar)

## Open questions / decisions to revisit

- Level 2 `+` button placement.
- Drag-to-stack collision zones — confirm center=stack / edges=insert-column model with a real prototype.
- Level 2 deck interaction — single-tap on a deck: zoom in to L1 at that cluster with that column's focused row selected? Tap on a specific card in the tilted deck: same as tapping the deck, or focus-that-card-specifically?
- Level 3 form factor.

## Anti-patterns (do not do)

- Tearing down and recreating tile DOM elements when transitioning between Level 1 and Level 2. Same elements must morph under the axonometric transform.
- Per-client xterm.js replay at different dimensions. Cursor-positioned TUI output cannot be reflowed. (See `CLAUDE.md` "Multi-device terminal dimensions".)
- macOS Terminal.app-style vertical splits that shrink siblings to uselessness.
- Adding "New Cluster" to the per-tile `+` menu. Cluster management lives at Level 2.
- Bundling pinch animation and column stacking into the same implementation pass.
- Adding a second view mode ("exposé", "grid view", etc.) to Level 1. L1 is the carousel; L2 is the tilted-deck overview; that's the whole set.

## Reference material

- Webflow draggable carousel that matches Level 2 strip behavior: <https://auto-replicating-draggable-carousel.webflow.io/>
- macOS virtual-desktops strip as the reference for the Level 2 mental model (though our Level 2 is a *vertical* stack of cluster strips, not a horizontal strip of desktop thumbnails).
