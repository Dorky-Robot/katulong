# Tile System

The tile system is katulong's architecture for composable, pluggable UI surfaces on the iPad carousel. Instead of hardcoding terminal sessions as the only card type, tiles are generic containers with a standard interface that any content can fill.

## Core Concepts

### Tiles are generic containers

A tile is a card in the carousel that can hold anything — a terminal, a dashboard, a web preview, a markdown document, AI chat, or custom content. The carousel doesn't know what's inside a tile; it only knows how to position, focus, and flip them.

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

Wraps the existing `terminalPool` as a tile. Each instance manages a single tmux session.

```js
createTile("terminal", { sessionName: "dev" })
```

- `mount()` → `terminalPool.getOrCreate()`, protects from LRU eviction
- `focus()` → `setActive()`, `attachControls()`, `term.focus()`
- `resize()` → `terminalPool.scale()`
- The terminal's pull-based WebSocket output continues to work unchanged

### Dashboard Tile

A configurable CSS Grid that contains sub-tiles. Any tile type can be nested.

```js
createTile("dashboard", {
  cols: 3,                         // number of columns
  rows: 2,                         // number of rows
  maxCellWidth: "400px",           // optional max width per column
  gap: 8,                          // gap between cells in px
  title: "My Dashboard",
  slots: [
    { type: "terminal", sessionName: "dev" },
    { type: "terminal", sessionName: "logs", colSpan: 2 },
    { type: "terminal", sessionName: "tests" },
  ]
})
```

Options:

| Option | Type | Description |
|--------|------|-------------|
| `cols` | number | Number of columns |
| `rows` | number | Number of rows (auto-computed from slots if omitted) |
| `cells` | number | Shorthand: auto-compute squarest grid for N cells |
| `maxCellWidth` | string | CSS max-width per column (e.g. `"400px"`) |
| `gap` | number | Gap between cells in px (default: 8) |
| `title` | string | Custom dashboard title |
| `slots` | array | Sub-tile definitions (see below) |

Each slot can include `colSpan` and `rowSpan` to span multiple grid cells.

The `cells` shorthand auto-picks the squarest arrangement:
- `cells: 1` → 1x1
- `cells: 2` → 2x1
- `cells: 3` → 2x2 (with one empty)
- `cells: 4` → 2x2
- `cells: 6` → 3x2
- `cells: 9` → 3x3

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

To create a new tile type:

1. **Create the tile module** at `public/lib/tiles/my-tile.js`:

```js
export function createMyTileFactory(deps) {
  return function createMyTile(options) {
    let container = null;

    return {
      type: "my-tile",

      mount(el, ctx) {
        container = el;
        // Build your DOM, append to el
        // Use ctx.chrome to populate toolbar/sidebar/shelf
        // Use ctx.sendWs() to communicate with the server
        // Use ctx.flip() to flip the card
      },

      unmount() {
        // Clean up DOM, listeners, timers
        container = null;
      },

      focus() {
        // This tile is now visible and active
      },

      blur() {
        // This tile lost focus (another card is active)
      },

      resize() {
        // Container size changed, refit your content
      },

      getTitle() {
        return options.title || "My Tile";
      },

      getIcon() {
        return "browser";  // Phosphor icon name
      },

      serialize() {
        return { type: "my-tile", ...options };
      },
    };
  };
}
```

2. **Register it** in `app.js`:

```js
import { createMyTileFactory } from "/lib/tiles/my-tile.js";
registerTileType("my-tile", createMyTileFactory({ ...deps }));
```

3. **Create instances**:

```js
const tile = createTile("my-tile", { title: "Hello" });
carousel.addCard("my-tile-1", tile);
```

## Future: Generative Tiles

A planned extension where processes (like Claude Code) can stream UI descriptions into tiles at runtime, using a compact DSL similar to [OpenUI Lang](https://www.openui.com/docs/openui-lang/specification). This would enable:

- Claude Code generating dashboards, charts, and status views on the fly
- Scripts producing rich output beyond terminal text
- Live-updating visualizations driven by process output

The delivery mechanism would be OSC escape sequences or CLI commands, with the tile rendering a component library (stat cards, grids, charts, tables, markdown, code blocks) from the streamed descriptions.
