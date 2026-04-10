# Tile State Rewrite — First Principles

## The problem we're solving

After shipping file-browser-as-a-tile (`f32f40e`), the tile system
"kinda works" but every bug fix chased the same underlying shape:

- Three sources of truth maintained by hand
  1. `carousel` (internal card list, order, focus)
  2. `windowTabSet` (sessionStorage per-window tab id list)
  3. `sessionStore` (terminal session list for the bar)
- Every mutation site (drag reorder, tab click, focus change, restore,
  add tile, remove tile) has to update all three in the right order or
  they drift.
- Persistence sneaks in as a fourth: `localStorage["katulong-carousel"]`
  is written reactively from the carousel, but URL-driven boot clobbers
  it before the 500 ms `setTimeout` restore runs, so we had to snapshot
  localStorage at carousel construction.
- Tiles are long-lived stateful objects (`mount/unmount/focus/blur/
  serialize/getTitle`). When the file browser navigates, it has to push
  its title upward via `ctx.setTitle`, which has to re-render the bar,
  which has to re-read the tile via a shim in `getSessionList`. The
  title is live in three places.
- Non-terminal tile ids can't live in `?s=`, so `onFocusChange`,
  `onTabClick`, and `bar.render` each branch on "is this a terminal".
- `NON_PERSISTABLE_TILE_TYPES` is a host-side string set that has to
  stay in lockstep with `persistable:` flags on tile prototypes.

Every bug in the checkpoint PR was some variant of "source A and source
B disagreed." The fix was always another manual sync call.

## First principles

1. **One state atom.** There is exactly one object describing the UI.
   It lives in `localStorage` (persisted) and in a `createStore`
   instance (in memory). Everything derives from it.
2. **Render is a pure function of state.** Tab bar, carousel pane,
   and focus highlight are views. You never mutate DOM without first
   mutating state.
3. **Tiles are descriptors, not objects.** A tile is a plain
   `{id, type, props}` record in state. A `type` has a matching
   **renderer** (pure function of `props` → DOM or mount callback).
   No per-tile classes with lifecycle methods the host has to call in
   the right order.
4. **URL `?s=` is a boot hint, not live state.** At boot we read it
   once and dispatch an action that adds or focuses a terminal tile.
   After boot the URL is never the source of truth; it's written from
   state for bookmarkability only.
5. **Terminal sessions stay decoupled.** The session manager and
   `sessionStore` continue to own PTY session lifecycle. The tile
   state references sessions by name via `props.sessionName`. The bar
   does *not* merge `sessionStore` into its tab list any more — tabs
   are strictly derived from tile state.

## The state shape

```js
// localStorage["katulong-ui-v1"]
{
  version: 1,
  tiles: {
    "session-abc": {
      id: "session-abc",
      type: "terminal",
      props: { sessionName: "session-abc" }
    },
    "file-browser-xyz": {
      id: "file-browser-xyz",
      type: "file-browser",
      props: { cwd: "/Users/felixflores" }
    }
  },
  order: ["file-browser-xyz", "session-abc"],  // left → right
  focusedId: "file-browser-xyz"
}
```

Invariants:

- `order` is a permutation of `Object.keys(tiles)`.
- `focusedId` is either `null` or a key of `tiles`.
- Duplicate ids are impossible (tiles is a map).
- Every mutation returns a new state object (structural sharing).

## Actions

```
ADD_TILE       { tile: {id, type, props}, focus?: bool, insertAt?: "end"|"afterFocus" }
REMOVE_TILE    { id }
REORDER        { order: [id,...] }                  // full new order
FOCUS_TILE     { id }
UPDATE_PROPS   { id, patch }                        // merge into tile.props
RESET          { state }                            // for boot / restore
```

That's the whole API. No `reorderCards` + `reorderTabs` + `save()`
triad. One dispatch.

## Renderers — replacing tile prototypes

Each tile `type` registers a **renderer** at module load:

```js
// public/lib/tile-renderers/terminal.js
export const terminalRenderer = {
  type: "terminal",

  // Pure: props → view metadata. Used by the tab bar.
  describe(props) {
    return {
      title: props.sessionName,
      icon: "terminal",
      persistable: true,
    };
  },

  // Imperative mount onto a DOM node. Returns teardown + an optional
  // focus() handle. The renderer may dispatch UPDATE_PROPS at any time
  // to push state back into the atom (e.g. fb dispatching new cwd).
  mount(el, { id, props, dispatch, ctx }) {
    // ...xterm setup, WS wiring, etc.
    return {
      unmount() { /* ... */ },
      focus()   { /* ... */ },
      resize()  { /* ... */ },
    };
  },
};
```

`describe()` is what the tab bar calls — no more `tile.getTitle()`
method-on-instance. Because `describe` is pure and takes `props`, when
`props.cwd` changes the new title falls out automatically the next
render.

The file-browser renderer's `mount` subscribes to its internal store
and calls `dispatch({ type: "UPDATE_PROPS", id, patch: { cwd: deepest }})`
whenever navigation changes. The tab bar re-renders on the next state
change and picks up the new title via `describe(newProps)`. No
`ctx.setTitle`, no bar-specific shim.

## The render pipeline

```
state change
    ↓
subscribe listener
    ↓
renderUI(state, prevState)
    ├── diffTiles(prev.tiles, next.tiles)
    │     → mount new, unmount removed, leave kept alone
    ├── reorderDom(state.order)
    │     → move existing nodes (cheap) instead of remount
    ├── applyFocus(state.focusedId)
    │     → set active class + call renderer.focus()
    └── renderTabBar(state)
          → pure derive: state.order.map(id => describe(state.tiles[id].props))
```

Two rules:

- **Never remount a tile that didn't change.** Reorder moves its DOM
  node; prop updates go through the renderer's own subscription.
- **Tab bar is a pure derive.** No caching, no shim, no `sessionStore`
  merge. The whole bar is `renderTabs(state.order, state.focusedId,
  state.tiles)`.

## Persistence

```js
store.subscribe((state) => {
  localStorage.setItem("katulong-ui-v1", JSON.stringify(serialize(state)));
});
```

`serialize(state)` drops tiles whose type's `describe().persistable ===
false` from the persisted copy. That's the *only* place the persistable
flag is consulted, and it reads from the renderer, not a host-side
constant set. `NON_PERSISTABLE_TILE_TYPES` goes away.

Boot:

```js
const initial = loadFromLocalStorage() || { tiles: {}, order: [], focusedId: null };
const hintedSession = new URL(location).searchParams.get("s");
if (hintedSession && !initial.tiles[hintedSession]) {
  initial.tiles[hintedSession] = { id: hintedSession, type: "terminal", props: { sessionName: hintedSession }};
  initial.order.push(hintedSession);
}
if (hintedSession) initial.focusedId = hintedSession;
store.dispatch({ type: "RESET", state: initial });
```

No `setTimeout(500)`. No "carousel-already-active" merge path. Boot is
a single reducer call.

## URL sync (terminal-only)

```js
store.subscribe((state) => {
  const focused = state.tiles[state.focusedId];
  if (focused?.type === "terminal") {
    const url = new URL(location);
    url.searchParams.set("s", focused.props.sessionName);
    history.replaceState(null, "", url);
  }
  // Non-terminal focus: leave URL alone. The ?s= hint keeps pointing
  // at whatever terminal the user last focused.
});
```

That's the entire URL sync. The branching in `onFocusChange`,
`onTabClick`, `bar.render` collapses to this one subscribe.

## Drag reorder

```js
// In tab bar drag handler
function onDrop(newOrder) {
  store.dispatch({ type: "REORDER", order: newOrder });
}
```

That's it. `windowTabSet` is deleted. `carousel.reorderCards` is
deleted. The subscribe-bridge is deleted. Rendering re-derives from
`state.order` and moves DOM nodes.

## What gets deleted

- `windowTabSet` module (subsumed by state atom)
- `NON_PERSISTABLE_TILE_TYPES` set
- Carousel's internal localStorage save/restore/snapshot logic
- `tile.getTitle()` / `tile.getIcon()` / `tile.serialize()` methods
- `ctx.setTitle` / `ctx.setIcon`
- The `500 ms setTimeout` restore merge path
- The "carousel-already-active" branch in app.js restore
- `getSessionList()`'s sessionStore-merge shim in shortcut-bar
- Per-mutation-site "sync these three stores" boilerplate
- All `console.log("[carousel.save] ..."` debug logs (dev artifact)

## What stays as-is

- xterm.js, terminal pool, WS connection, session manager — none of
  this knows or cares about tiles.
- `sessionStore` keeps its job: tracking server-side PTY sessions (for
  the "new session" list and API bookkeeping). It just stops being
  consulted by the tab bar.
- The file-browser component/store internals.
- Tile-chrome, card faces, pinch/expose/morph gestures — carousel
  continues to own the visual presentation of cards; it just exposes a
  pure `setTiles(order, focused)` API driven by the store.

## Build order

1. **Add `ui-store.js`** — reducer, actions, persistence, URL sync.
   Standalone; no consumers yet.
2. **Add renderer registry** (`tile-renderers/index.js`) with
   `terminal`, `file-browser`, `cluster` renderers as thin wrappers
   over the existing tile factories. Each exposes `describe(props)`
   and `mount(el, api)`.
3. **New `tile-host.js`** — subscribes to the store, diffs
   `prev.tiles`/`next.tiles`, mounts/unmounts/reorders via renderers.
   Replaces the imperative carousel add/remove/focus API from app.js's
   perspective. Carousel stays internal to tile-host.
4. **Rewrite tab bar tab-rendering path** to derive purely from
   `state.order` + `state.tiles` + `state.focusedId`. Drag reorder
   dispatches `REORDER`. Click dispatches `FOCUS_TILE`.
5. **Rewrite app.js boot** — single `RESET` dispatch from localStorage
   + `?s=` hint. Delete the setTimeout restore path.
6. **Delete dead code** (see "What gets deleted"). Remove debug logs.
7. **Manual test matrix:**
   - Fresh boot with `?s=term`
   - Fresh boot with persisted fb tile
   - Add fb tile → reload → fb returns at same cwd, focused
   - Drag reorder (fb + term) → reload → order preserved
   - Navigate fb into folder → tab label updates live
   - Close fb → tab disappears → reload → still gone
   - Click terminal tab while fb focused → terminal focuses, URL
     updates, fb stays in list

## Out of scope for this rewrite

- Clusters keep their existing internal structure (they're a tile that
  manages child PTYs). `cluster` renderer just wraps the existing
  factory.
- Pinch/expose/morph gestures stay exactly as they are; the carousel's
  external surface is what changes, not its gesture handling.
- No new features. This is pure architecture simplification.

## Rollback plan

The checkpoint commit `f32f40e` is the last "imperative but working"
state. If the rewrite lands and regresses something we didn't catch,
`git revert` is a clean escape hatch.
