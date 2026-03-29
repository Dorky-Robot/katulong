# Tile System

The tile system is katulong's core architecture. Everything is a tile — terminals, notes, dashboards, file browsers, custom extensions. The carousel doesn't know what's inside a tile; it only knows how to position, focus, and flip them. The terminal is just another tile type, not a special case.

## Core Concepts

### Tiles are the primary abstraction

A tile is a card in the carousel that can hold any functionality. On tablets and phones, tiles appear as swipeable cards. On desktop, they work as tabs. Each tile manages its own UI, state, and lifecycle. Tiles communicate with each other and with the server through a pub/sub event system — like Excel cells that can reference and react to each other.

### Tile Prototype Interface

Every tile type implements this interface:

```js
{
  type: string,                    // "terminal", "dashboard", "html", etc.
  mount(container, ctx): void,     // Insert content into the DOM container
  unmount(): void,                 // Remove content, clean up listeners/timers
  focus(): void,                   // This tile is now the active card
  blur(): void,                    // This tile lost focus
  resize(): void,                  // Container size changed, refit content
  getTitle(): string,              // Display title for the tab bar
  getIcon(): string,               // Phosphor icon name for the tab bar
}
```

Optional methods (duck-typed):

```js
serialize(): object               // Return state for persistence
restore(state): void              // Restore from serialized state
canClose(): boolean               // Return false to show confirmation before close
```

### Tile Context

When a tile is mounted, it receives a `TileContext` object with services:

```js
{
  tileId: string,                  // Unique tile instance ID
  sendWs(msg): void,              // Send a WebSocket message to the server
  onWsMessage(type, handler): fn, // Subscribe to WS messages, returns unsubscribe
  setTitle(title): void,          // Update this tile's tab title dynamically
  setIcon(icon): void,            // Update this tile's tab icon dynamically
  flip(): void,                   // Flip this card to show the other face
  chrome: TileChrome,             // Access to tile chrome zones (see below)
}
```

### Tile Registry

Tile types are registered at startup. A registry maps type names to factory functions:

```js
import { registerTileType, createTile } from "/lib/tile-registry.js";

registerTileType("terminal", createTerminalTileFactory({ terminalPool }));
registerTileType("dashboard", createDashboardTileFactory({ createTileFn: createTile }));

const tile = createTile("terminal", { sessionName: "dev" });
```

Factories are closures that capture shared dependencies (e.g. `terminalPool`) and return tile instances.

## Built-in Tile Types

### Terminal Tile

The only built-in tile. Wraps the `terminalPool` as a tile — each instance manages a single tmux session.

```js
createTile("terminal", { sessionName: "dev" })
```

- `mount()` → `terminalPool.getOrCreate()`, protects from LRU eviction
- `focus()` → `setActive()`, `attachControls()`, `term.focus()`
- `resize()` → `terminalPool.scale()`
- Subscribes to its session topic for pull-based output

All other tile types (notes, dashboards, file browser, etc.) are extensions installed in `~/.katulong/tiles/`. See [Tile SDK](tile-sdk.md) for how to build them.

## Flippable Cards

Every carousel card has a front face and a back face. By default only the front face has content. A back tile can be assigned at any time, and the card flips between them with a CSS 3D animation.

```js
// Assign a back face to a card
carousel.setBackTile("dev", createTile("dashboard", { ... }));

// Flip to show the back face
carousel.flipCard("dev");

// Flip back to the front
carousel.flipCard("dev");

// Force a specific face
carousel.flipCard("dev", true);   // show back
carousel.flipCard("dev", false);  // show front

// Check current state
carousel.isFlipped("dev");        // true or false
```

The flip animation is a `rotateY(180deg)` with `backface-visibility: hidden` on both faces, using `perspective: 1200px` for a natural 3D effect. The animation takes 500ms with an ease-out curve.

Both faces have independent tile lifecycles — the hidden face stays mounted but blurred. This means a terminal on the front keeps running while you look at a dashboard on the back.

### Use Cases

- **Terminal + Dashboard**: terminal on front, generated visualization on back. Claude Code runs commands, generates a dashboard, flips the card to show results.
- **Code + Preview**: terminal on front, web preview iframe on back. Edit code, flip to see the result.
- **Editor + Rendered**: markdown source on front, rendered markdown on back.

## Tile Chrome Zones

Each tile card has optional chrome zones that tiles or plugins can populate. Zones collapse to zero size when empty.

```
┌─────────────────────────────────────┐
│ [toolbar]                        ⟳  │
├──────────┬──────────────────────────┤
│          │                          │
│ [sidebar]│       [content]          │
│          │                          │
│          │                          │
├──────────┴──────────────────────────┤
│ [shelf]                             │
└─────────────────────────────────────┘
```

### Toolbar (top)

A horizontal bar at the top of the tile. Use for:
- Title text
- Action buttons (flip, settings, close)
- Status indicators
- Breadcrumbs

```js
ctx.chrome.toolbar.setTitle("Dev Terminal");
ctx.chrome.toolbar.addButton({
  icon: "swap",
  label: "Flip",
  onClick: () => ctx.flip(),
});
ctx.chrome.toolbar.addButton({
  icon: "gear",
  label: "Settings",
  position: "right",
  onClick: () => openSettings(),
});
```

### Sidebar (left)

A vertical panel on the left side of the tile. Use for:
- File trees
- Navigation
- Tool palettes
- Session lists

```js
ctx.chrome.sidebar.mount(myTreeComponent);   // mount a DOM element or component
ctx.chrome.sidebar.setWidth("200px");         // set width (default: auto)
ctx.chrome.sidebar.collapse();                // collapse to zero width
ctx.chrome.sidebar.expand();                  // restore width
```

### Shelf (bottom)

A horizontal bar at the bottom of the tile. Use for:
- Chat input
- Status bar
- Quick actions
- Progress indicators

```js
ctx.chrome.shelf.mount(myChatInput);
ctx.chrome.shelf.setHeight("48px");
```

### Chrome Design Principles

- **Zones are optional.** If no one populates a zone, it has zero size. No empty bars.
- **Zones are shared.** Multiple sources can add buttons to the toolbar. The chrome system manages ordering and overflow.
- **Zones are per-face.** Front and back faces have independent chrome. Flipping the card shows the chrome for that face.
- **Zones are responsive.** On small screens, the sidebar auto-collapses. The toolbar wraps or shows an overflow menu.

## Ways to Trigger a Flip

The flip can be triggered from multiple surfaces:

### UI (user-initiated)

- **Toolbar button**: Tile adds a flip button to its toolbar via `ctx.chrome.toolbar.addButton()`.
- **Swipe gesture**: Vertical swipe on a card flips it (horizontal swipe navigates between cards).
- **Tab bar indicator**: Cards with a back face show a flip icon on their tab.

### Terminal (process-initiated)

- **OSC escape sequence**: Any process in a terminal can flip its own card:
  ```bash
  printf '\033]7338;flip\007'
  ```
- **CLI command**: `katulong tile flip [session]`

### Programmatic

- **`carousel.flipCard(id)`**: Direct API call from JavaScript.
- **`ctx.flip()`**: A tile flips its own card via its context.
- **WebSocket message**: `{ type: "flip-tile", session: "dev" }` — server or remote client triggers a flip.
- **Inter-tile messaging**: One tile triggers a flip on another tile.

## Tile Sizing

Tile sizing operates at two levels:

### Top-level cards (carousel)

Each carousel card is always full-width. The `translateX` swipe model stays unchanged. One swipe = one card transition. To see two things simultaneously, use a dashboard tile.

### Sub-tiles (within dashboard)

Smaller tiles exist as cells inside a dashboard tile, laid out via CSS Grid. The dashboard's `cols`, `rows`, `maxCellWidth`, and `colSpan`/`rowSpan` control the layout.

## Persistence

Tile layouts persist in `sessionStorage` (survives page reloads within a browser session). The carousel's `save()` method calls `tile.serialize()` on each tile and stores the result. On restore, tiles are recreated via the registry's `createTile(type, state)`.

The persistence format supports backward compatibility — legacy formats (array of session name strings) are auto-detected and wrapped in terminal tile descriptors.

## Creating a New Tile Type

There are two ways to create a tile: as a **built-in tile** (shipped with katulong source) or as an **extension tile** (installed in `~/.katulong/tiles/`).

### Built-in tiles

1. **Create the tile module** at `public/lib/tiles/my-tile.js`:

```js
export function createMyTileFactory(deps) {
  return function createMyTile(options) {
    let container = null;

    return {
      type: "my-tile",
      mount(el, ctx) { container = el; /* build DOM */ },
      unmount() { container = null; },
      focus() {},
      blur() {},
      resize() {},
      getTitle() { return options.title || "My Tile"; },
      getIcon() { return "browser"; },
      serialize() { return { type: "my-tile", ...options }; },
    };
  };
}
```

2. **Register it** in `app.js`:

```js
import { createMyTileFactory } from "/lib/tiles/my-tile.js";
registerTileType("my-tile", createMyTileFactory({ ...deps }));
```

### Extension tiles

Extension tiles live in `~/.katulong/tiles/<name>/` and are discovered automatically. They follow the same factory pattern but receive an SDK object instead of raw dependencies. See [Tile SDK](tile-sdk.md) for the full guide.

```js
// ~/.katulong/tiles/my-tile/tile.js
export default function setup(sdk, options) {
  return function createMyTile(opts = {}) {
    return {
      type: "my-tile",
      mount(el, ctx) { el.textContent = "Hello!"; },
      unmount() {},
      focus() {},
      blur() {},
      resize() {},
      getTitle() { return "My Tile"; },
      getIcon() { return "star"; },
    };
  };
}
```

Extension tiles appear in the `+` menu alongside built-in tiles after a page refresh.

## Extension System

The extension system allows tiles to be installed without modifying katulong's source code. Extensions are discovered at server startup and loaded by the client before carousel restore.

### Discovery (server)

`lib/tile-extensions.js` scans `~/.katulong/tiles/` for directories containing both `manifest.json` and `tile.js`. It exposes two routes:

- `GET /api/tile-extensions` — JSON list of discovered extensions (re-scanned on each request)
- `GET /tiles/:name/:path` — serves extension files (JS, CSS, JSON, images) with correct MIME types

Both routes require authentication. File serving includes path traversal protection and extension name validation.

### Loading (client)

`public/lib/tile-extension-loader.js` runs during the app boot sequence, **before** carousel restore:

1. Fetches `/api/tile-extensions`
2. For each extension, dynamically imports `/tiles/{name}/tile.js`
3. Creates a namespaced SDK instance via `createTileSDK(type, deps)` from `public/lib/tile-sdk-impl.js`
4. Calls `setup(sdk, options)` → gets back a factory function
5. Registers the factory with `registerTileType(type, factory)`

Because extensions load before restore, saved extension tiles in `sessionStorage` are recreated correctly. Unknown tile types during restore are skipped gracefully.

### SDK

Each extension gets its own SDK instance (`public/lib/tile-sdk-impl.js`) with:

| API | Description |
|-----|-------------|
| `sdk.storage` | Namespaced localStorage (`katulong-tile-{type}:key`) |
| `sdk.platform` | Device detection (isIPad, isPhone, isDesktop, isDark, version) |
| `sdk.api` | HTTP client (get, post, put, del) with auth cookies |
| `sdk.toast` | Toast notifications |
| `sdk.ws` | WebSocket send/subscribe |
| `sdk.pubsub` | In-browser event bus |
| `sdk.sessions` | Terminal session management (list, create, kill) |

See [Tile SDK](tile-sdk.md) for the full API reference.

## Tile Orchestration

Tiles can communicate through the pub/sub system, enabling workflows where one tile's output triggers another tile's action:

- A terminal tile running a build → emits a `build:complete` event → a dashboard tile refreshes
- A Plano tile with a task list → an agent picks up the next task → a terminal tile executes it
- A CI tile detects a failure → emits an event → a notes tile auto-creates a bug report

This is inspired by spreadsheets: each tile is like a cell, and the pub/sub events are like formulas that reference other cells. The difference is that the "formulas" are agents, APIs, and human input.

### CLI Integration

The `katulong pub` and `katulong sub` CLI commands let any process — scripts, agents, CI pipelines — participate in tile orchestration without being a tile themselves:

```bash
# Notify all subscribers of a topic
katulong pub build:status '{"project":"katulong","status":"passed"}'

# Subscribe to events from the terminal
katulong sub deploy:progress
```

## Future Directions

### Tile Marketplace

A repository of community tiles installable via CLI:

```bash
katulong install dorky-robot/plano
katulong install dorky-robot/diwa-insights
```

Tiles are cloned into `~/.katulong/tiles/` and available on next page load.

### Generative Tiles

Processes (like Claude Code) streaming UI descriptions into tiles at runtime. A terminal tile could emit structured output that a companion tile renders as charts, tables, or status cards — rich output beyond terminal text.
