# File Browser Refactor — Reliability and Composability

## The problem we're solving

The file browser tile sometimes shows an infinite spinner that never
resolves. The user has to close the tile and reopen it. Beyond the bug,
the file browser component (`file-browser-component.js`, ~400 lines) is
a monolith that mixes DOM templates, event delegation, rendering,
keyboard handling, and store subscriptions — making it a poor template
for building future non-terminal tile types.

The generic tile infrastructure (ui-store, tile-host, renderers, tab
bar) is already type-agnostic and clean. The problem is entirely inside
the file browser's own modules.

## Root cause analysis

### Why the spinner gets stuck

The spinner renders when `col.loading === true` in the store. Loading
is set by `SET_COLUMN_LOADING` and should be cleared by `SET_COLUMN`
(success) or `SET_COLUMN_ERROR` (failure).

**Primary cause: `fetch()` has no timeout.** `api.get()` in
`api-client.js:37` calls raw `fetch(url)` with no AbortController or
timeout. If the connection drops (tunnel reconnect, server restart,
network blip), the promise hangs forever. `SET_COLUMN_LOADING` fires
but neither `SET_COLUMN` nor `SET_COLUMN_ERROR` ever follow. The
column stays `loading: true` indefinitely.

```js
// api-client.js:37 — no timeout, no abort
get: (url) => fetch(url).then(r => r.ok ? r.json() : Promise.reject(...))
```

**Secondary cause: navigation race conditions.** Clicking folder A
then quickly clicking folder B fires two concurrent fetches for the
same column index. Both dispatch `SET_COLUMN_LOADING`. If A's response
arrives after B's, it dispatches `SET_COLUMN` with stale data,
overwriting B's correct entries. This isn't a stuck spinner per se, but
it shows the wrong directory contents.

**Tertiary cause: `refreshAll()` swallows errors.** The catch block
at `file-browser-store.js:155` uses a bare `break` without dispatching
`SET_COLUMN_ERROR`. If a column was in loading state from a prior
operation, `refreshAll` can't clear it.

### Why the component is hard to extend

`file-browser-component.js` owns:
- DOM template (toolbar HTML, columns container, status bar)
- Event binding (click, dblclick, contextmenu, keydown on columns)
- Button wiring (back, forward, refresh, hidden toggle, close)
- Render logic (column reconciliation, per-column rendering, breadcrumb)
- Store subscription lifecycle

A new tile type that wanted a toolbar + content area + status bar
pattern would have to copy-paste this structure. The rendering,
keyboard handling, and toolbar logic are tangled into the component
closure with no way to reuse individual pieces.

## Design principles

1. **Navigation is a controller, not bare functions.** `loadRoot`,
   `selectItem`, `refreshAll`, and `goBack` share cancellation state
   (which request is current). They belong in a scoped controller
   created per store instance, not as module-level exports that share
   implicit global state.

2. **Render functions are pure.** Given `(domNode, stateSlice)`,
   update the DOM. No store references, no subscriptions, no side
   effects. The component subscribes to the store and calls render
   functions — render functions never call back into the component.

3. **Toolbar is a composable primitive.** The toolbar pattern (nav
   buttons, breadcrumb, action buttons) is generic. A log viewer, image
   browser, or settings panel would want the same shell. Extract it as
   `createToolbar(callbacks) → { el, update(state) }`.

4. **Keyboard is a handler factory.** `createKeyboardHandler(nav) →
   (event, state) → void`. The component wires it to the DOM; the
   handler dispatches navigation actions. Testable without DOM.

## The navigation controller

```js
// file-browser-store.js
export function createNavController(store) {
  let generation = 0;

  async function loadRoot(path) {
    const gen = ++generation;
    store.dispatch({ type: "SET_COLUMN_LOADING", index: 0, path });
    try {
      const data = await fetchWithTimeout(`/api/files?path=${encodeURIComponent(path)}`);
      if (gen !== generation) return;  // stale — a newer nav superseded us
      store.dispatch({ type: "SET_COLUMN", index: 0, path: data.path, entries: sortEntries(data.entries) });
    } catch (err) {
      if (gen !== generation) return;
      store.dispatch({ type: "SET_COLUMN_ERROR", index: 0, error: err.message });
    }
  }

  async function selectItem(columnIndex, name) {
    // Same pattern: increment generation, guard dispatch after await
  }

  async function refreshAll() {
    // Dispatches SET_COLUMN_ERROR on failure instead of silent break
  }

  function goBack() {
    // Synchronous — no cancellation needed
  }

  return { loadRoot, selectItem, refreshAll, goBack };
}
```

The generation counter is the simplest cancellation pattern that works
in vanilla JS. Each nav action increments the counter before the
await. After the await, if the counter has moved, another action
superseded us — bail out silently. No AbortController ceremony needed
for the cancellation itself (though we still use AbortController for
the fetch timeout).

### Fetch timeout

```js
async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
```

This lives in `file-browser-store.js` (not in `api-client.js`). The
file browser has stricter latency requirements than other API callers
— a 15-second timeout is appropriate here but might be wrong for a
large file upload. Keeping the timeout local avoids changing the global
API client's contract.

## Module decomposition

### Before (current)

```
file-browser/
  file-browser-store.js      — state + async actions (tangled)
  file-browser-component.js  — monolith (template + events + render + keyboard)
  file-browser-actions.js    — file operations (rename, delete, upload, etc.)
  file-browser-context-menu.js
  file-browser-dnd.js
  file-browser-types.js      — icon mapping
```

### After

```
file-browser/
  file-browser-store.js      — state (reducer only) + createNavController
  file-browser-columns.js    — NEW: renderColumns(el, columns, showHidden)
  file-browser-toolbar.js    — NEW: createToolbar(callbacks) → {el, update}
  file-browser-keyboard.js   — NEW: createKeyboardHandler(nav) → handler
  file-browser-component.js  — SHRUNK: thin orchestrator (~80 lines)
  file-browser-actions.js    — file operations (receives nav controller)
  file-browser-context-menu.js  — unchanged
  file-browser-dnd.js        — receives nav controller for refreshAll
  file-browser-types.js      — unchanged
```

### `file-browser-columns.js`

Extracted from `file-browser-component.js` lines 277-350, 400-406.

```js
export function renderColumns(columnsEl, columns, showHidden) {
  // Reconcile column DOM elements (add/remove to match columns.length)
  // For each column: renderSingleColumn(colEl, col, i, showHidden)
  // Auto-scroll to rightmost column via rAF
}

export function renderSingleColumn(colEl, col, colIndex, showHidden) {
  // loading → spinner
  // error → error message
  // empty → "Empty"
  // entries → row HTML with data attributes
}
```

Pure functions. No store reference. The component calls them from its
subscribe callback.

### `file-browser-toolbar.js`

Extracted from `file-browser-component.js` lines 83-108, 240-260,
352-375.

```js
export function createToolbar({
  onBack, onForward, onRefresh, onToggleHidden, onClose, onBreadcrumbNav
}) {
  const el = document.createElement("div");
  el.className = "fb-toolbar";
  // Build toolbar DOM, wire button clicks to callbacks

  function update(state) {
    // Update back/forward disabled state
    // Update hidden toggle icon
    // Update breadcrumb (event delegation, not re-attach)
  }

  return { el, update };
}
```

Key improvement: breadcrumb uses event delegation. A single click
listener on the breadcrumb container reads `data-path` from the
clicked `.fb-crumb` element. The current code re-attaches click
handlers to every crumb span on every render — a minor leak and
unnecessary churn.

### `file-browser-keyboard.js`

Extracted from `file-browser-component.js` lines 170-237.

```js
export function createKeyboardHandler(nav, getState) {
  return function handleKeyDown(e) {
    const state = getState();
    // Arrow keys → selectItem / goBack
    // Enter → download file
    // Backspace → goBack
  };
}
```

### Simplified `file-browser-component.js`

```js
export function createFileBrowserComponent(store, nav, options = {}) {
  let root = null;
  let toolbar = null;
  let columnsEl = null;
  let unsubscribe = null;

  const keyboard = createKeyboardHandler(nav, store.getState);
  const contextMenu = createContextMenu({ onAction: ... });
  const actions = createFileBrowserActions(store, nav);

  function mount(el) {
    root = document.createElement("div");
    root.className = "fb-root";
    el.appendChild(root);

    toolbar = createToolbar({
      onBack: nav.goBack,
      onForward: () => { /* forward logic */ },
      onRefresh: nav.refreshAll,
      onToggleHidden: () => store.dispatch({ type: "TOGGLE_HIDDEN" }),
      onClose: options.onClose,
      onBreadcrumbNav: (path) => nav.loadRoot(path),
    });
    root.appendChild(toolbar.el);

    columnsEl = document.createElement("div");
    columnsEl.className = "fb-columns";
    columnsEl.tabIndex = 0;
    root.appendChild(columnsEl);

    // Status bar
    const statusEl = document.createElement("div");
    statusEl.className = "fb-status";
    root.appendChild(statusEl);

    // Event delegation on columns
    columnsEl.addEventListener("click", onColumnClick);
    columnsEl.addEventListener("dblclick", onColumnDblClick);
    columnsEl.addEventListener("contextmenu", onContextMenu);
    columnsEl.addEventListener("keydown", keyboard);

    initColumnDnD(columnsEl, store, nav);

    unsubscribe = store.subscribe(render);
    render();
  }

  function render() {
    const state = store.getState();
    toolbar.update(state);
    renderColumns(columnsEl, state.columns, state.showHidden);
    renderStatus(statusEl, state);
  }

  // ... event handlers delegate to nav/actions
  // ... unmount cleans up
}
```

## What changes in the tile/renderer layer

### `file-browser-tile.js`

Receives nav controller as a first-class collaborator:

```js
export function createFileBrowserTileFactory(_deps = {}) {
  return function createFileBrowserTile({ cwd = "", sessionName = null } = {}) {
    const store = createFileBrowserStore();
    const nav = createNavController(store);

    // ... tile.mount() passes nav to component
    // ... tile.mount() calls nav.loadRoot(cwd)
    // ... store subscription for cwd tracking unchanged
  };
}
```

### `tile-renderers/file-browser.js`

No structural change. The renderer's `mount()` still delegates to the
tile factory. The nav controller is internal to the tile — the renderer
doesn't see it.

## Build order

1. **Add `createNavController` + fetch timeout to `file-browser-store.js`**
   Keep existing bare function exports for now (they delegate to a
   module-level default controller for backward compat). Write tests.

2. **Extract `file-browser-columns.js`** — pure render functions.
   Component imports and calls them. No behavior change.

3. **Extract `file-browser-toolbar.js`** — toolbar factory.
   Component uses it instead of innerHTML template. Breadcrumb gets
   event delegation. No behavior change.

4. **Extract `file-browser-keyboard.js`** — keyboard handler factory.
   Component wires it. No behavior change.

5. **Simplify `file-browser-component.js`** — thin orchestrator.
   Receives `(store, nav, options)` instead of `(store, options)`.

6. **Wire nav controller through tile and actions** — update
   `file-browser-tile.js`, `file-browser-actions.js`,
   `file-browser-dnd.js` to use nav controller.

7. **Remove bare function exports from store** (or keep as deprecated
   pass-throughs if external consumers exist).

Each step is independently committable and testable. Steps 2-4 are
pure extractions with no behavior change — if any step goes wrong,
the blast radius is contained.

## What this enables

A new HTML tile follows the same pattern:

1. **Store**: `createMyStore()` — state shape + reducer
2. **Nav controller** (if async): `createNavController(store)` —
   scoped cancellation
3. **Render modules**: pure `(el, stateSlice) → DOM updates`
4. **Component**: thin orchestrator composing toolbar + content +
   keyboard + store subscription
5. **Tile factory** + **renderer**: same pattern as today

The file browser becomes the reference implementation that future tiles
copy.

## Out of scope

- Changing the generic tile infrastructure (ui-store, tile-host,
  renderers, tab bar) — it's already clean
- Performance optimization of column rendering (innerHTML → diffing) —
  fine for typical directory sizes
- New tile types — this PR just cleans the path; new tiles are
  separate work
- Changes to the file browser's visual design or UX
