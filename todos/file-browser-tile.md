# file-browser tile — audit & plan

## a) Can it be built on existing tile-chrome without additions?

Yes. `tile-chrome` builds `{ contentEl, chrome:{toolbar}, destroy }` on a
card face, but tiles themselves don't call it — card-carousel.js does, and
calls `tile.mount(contentEl)`. `contentEl` is a plain `<div>` with
`flex:1`. Mounting an arbitrary component (file browser component, which
is just `mount(el)`) works without any chrome change. terminal-tile.js
confirms: it appends its own DOM into the passed `el` and never touches
the toolbar. The file-browser tile will do the same — identical seam.

## b) Minimum new code

- `public/lib/tiles/file-browser-tile.js` — one new file, modeled on
  `terminal-tile.js`. Factory returns a tile with
  `{ type, mount, unmount, focus, blur, resize, getTitle, getIcon, serialize }`.
- `public/app.js`:
  - Import + instantiate factory.
  - `restoreTile` branch for `"file-browser"`.
  - `+` menu entry `{ type: "file-browser", name: "Files", icon: "folder" }`
    plus `onCreateTile` branch.
  - Rewire `onFilesClick` to create-or-focus a file-browser tile instead
    of `toggleFileBrowser()`.
  - Delete `toggleFileBrowser`, `closeFileBrowser`, `fileBrowserEl`,
    `fileBrowserMounted`, `fileBrowserComponent`. Leave the store import
    in place (the tile uses it).
- `public/index.html` — delete `#file-browser` div + overlay CSS.
- `test/file-browser-tile.test.js` — serialize/restore + mount asserts.

## c) Generic-container temptation?

Yes, and rejected. Temptation: "expose a generic HTML tile factory that
any future caller can wrap a component with." That is precisely the
html-tile / tile-registry zombie that PR #533 deleted. One hard-coded
in-tree tile kind is the rule. If a third kind arrives, it gets its own
file the same way; no registry, no manifest, no loader.

## d) Current overlay flow (`e`-key / Files button)

No literal `e` keybinding exists in code — the brief's wording referred
to the Files button. Path today:
`onFilesClick` → `toggleFileBrowser()` → on first open, constructs
`createFileBrowserComponent(store, {onClose})`, mounts into
`#file-browser` overlay div, fetches active session cwd via
`/sessions/cwd/:name`, calls `loadRoot(store, cwd)`, toggles `.active`
class to show overlay, hides terminal via `.fb-hidden`.

## e) Tile registration pattern (from terminal-tile)

1. `createXxxTileFactory(deps)` at boot — closes over deps.
2. `restoreTile(type, opts)` switch branch hands back a fresh instance.
3. `+` menu: `tileTypes` array entry + `onCreateTile` switch.
4. `addCard(id, tile, insertAtRightOfActive())` on creation.
5. `serialize()` returns `{ type, ...params }` for carousel save/restore.

## Plan approved — proceeding.
