# Tile SDK

The Tile SDK is the interface between custom tiles and the katulong platform. Tile authors create a directory in `~/.katulong/tiles/` with a manifest and a JS module. Katulong discovers them at startup and makes them available in the `+` menu.

## Directory Structure

```
~/.katulong/tiles/
  my-tile/
    manifest.json       — metadata (required)
    tile.js             — tile implementation (required)
    elements/           — custom elements, extra JS (optional)
    style.css           — custom styles (optional)
    README.md           — documentation (optional, for humans)
```

Built-in tiles live in the katulong source at `public/lib/tiles/` and follow the same interface. The `~/.katulong/tiles/` directory is for user-installed and community tiles.

## manifest.json

```json
{
  "name": "My Tile",
  "type": "my-tile",
  "description": "A brief description shown in the + menu",
  "icon": "browser",
  "version": "1.0.0",
  "author": "your-name",

  "config": [
    {
      "key": "url",
      "label": "URL",
      "type": "text",
      "placeholder": "https://example.com",
      "required": true
    },
    {
      "key": "refreshInterval",
      "label": "Refresh interval (seconds)",
      "type": "number",
      "default": 30
    }
  ]
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display name in the `+` menu |
| `type` | yes | Unique tile type identifier (used in registry and serialize) |
| `description` | no | One-line description |
| `icon` | no | Phosphor icon name (default: `"puzzle-piece"`) |
| `version` | no | Semver version |
| `author` | no | Author name |
| `config` | no | Configuration fields shown when creating the tile |

### Config Field Types

| Type | Description |
|------|-------------|
| `text` | Single-line text input |
| `number` | Numeric input |
| `boolean` | Toggle/checkbox |
| `select` | Dropdown with `options: [{label, value}]` |
| `secret` | Password/token field (masked input) |
| `textarea` | Multi-line text |

Config values are passed to the tile's `setup()` function in the `options` argument.

## tile.js

The main module. Must export a default `setup(sdk, options)` function that returns a **factory function**. The factory is called each time the user creates a new tile instance.

```js
// setup(sdk, options) → factory(opts) → TilePrototype
export default function setup(sdk, options) {
  // sdk = katulong platform APIs (storage, platform, api, toast, ws, pubsub, sessions)
  // options = { config: [...] } from the extension loader

  return function createMyTile(opts = {}) {
    // opts = {} for new tiles, or serialized state on restore
    let el = null;
    let ctx = null;

    return {
      type: "my-tile",

      mount(container, tileCtx) {
        el = container;
        ctx = tileCtx;

        // Use chrome zones (when available — check before using)
        if (ctx?.chrome?.toolbar) {
          ctx.chrome.toolbar.setTitle("My Tile");
          ctx.chrome.toolbar.addButton({
            icon: "arrow-clockwise",
            label: "Refresh",
            position: "right",
            onClick: () => refresh(),
          });
        }

        // Build your UI inside the container
        const div = document.createElement("div");
        div.textContent = "Hello from my tile!";
        container.appendChild(div);
      },

      unmount() {
        if (ctx?.chrome?.sidebar) ctx.chrome.sidebar.unmount();
        el = null;
        ctx = null;
      },

      focus() { /* tile gained focus */ },
      blur() { /* tile lost focus */ },
      resize() { /* container size changed */ },
      getTitle() { return "My Tile"; },
      getIcon() { return "browser"; },

      serialize() {
        // Return state for persistence (survives page reload)
        return { type: "my-tile", someState: "value" };
      },
    };
  };
}
```

### The Two-Level Factory Pattern

The tile system uses a two-level factory:

1. **`setup(sdk, options)`** runs once per extension when katulong loads. It receives the SDK and returns a factory function. Use this level for one-time initialization (loading web components, setting up shared state).

2. **`factory(opts)`** runs each time a tile instance is created (from the `+` menu or during carousel restore). The `opts` parameter is either `{}` for new tiles or the saved state from `serialize()` for restored tiles.

This matches how built-in tiles work:

```js
// Built-in: createHtmlTileFactory() → factory(opts) → TilePrototype
// Extension: setup(sdk, options) → factory(opts) → TilePrototype
```

## SDK Reference

The `sdk` object passed to `setup()` provides access to katulong platform APIs. Each extension gets its own SDK instance with namespaced storage.

### sdk.storage

Per-tile persistent key/value store. Data persists in `localStorage`, namespaced by tile type (`katulong-tile-{type}:`). Survives page reloads and browser restarts.

```js
// Store a value (JSON-serialized automatically)
sdk.storage.set("notes", { id1: { title: "Hello", content: "..." } });

// Retrieve a value (returns null if not found)
const notes = sdk.storage.get("notes");

// Remove a value
sdk.storage.remove("notes");

// List all keys in this tile's namespace
const keys = sdk.storage.keys();  // ["notes", "settings"]

// Clear all data for this tile type
sdk.storage.clear();
```

Storage is isolated between tile types. A "plano" tile cannot read storage from an "alpha" tile.

### sdk.platform

Read-only platform information. All properties are getters (live values).

```js
sdk.platform.isIPad;      // true on iPad (including desktop-mode iPads)
sdk.platform.isPhone;     // true on iPhone/Android mobile
sdk.platform.isDesktop;   // true on desktop (not iPad, not phone)
sdk.platform.isDark;      // true if prefers-color-scheme: dark
sdk.platform.version;     // katulong version string
```

### sdk.api

HTTP client for katulong's REST API. Automatically includes auth cookies.

```js
// GET — returns parsed JSON or null on error
const data = await sdk.api.get("/sessions");

// POST
const result = await sdk.api.post("/sessions", { name: "new-session" });

// PUT
await sdk.api.put("/some/resource", { key: "value" });

// DELETE
await sdk.api.del("/sessions/my-session");
```

If the app provides an `api` module, the SDK wraps it. Otherwise it falls back to plain `fetch` with JSON headers.

### sdk.toast

Show toast notifications.

```js
// Success toast
sdk.toast("Saved successfully");

// Error toast
sdk.toast("Something went wrong", { isError: true });

// Custom duration
sdk.toast("Quick message", { duration: 1500 });
```

### sdk.ws

Low-level WebSocket access. Messages are JSON-serialized automatically.

```js
// Send a message to the server
sdk.ws.send({ type: "my-message", data: "hello" });

// Listen for messages (returns unsubscribe function)
const unsub = sdk.ws.on("my-response", (msg) => {
  console.log(msg);
});
unsub();
```

### sdk.pubsub

In-browser event bus for communication between tiles and the app.

```js
// Subscribe to an event (returns unsubscribe function)
const unsub = sdk.pubsub.on("my-tile:updated", (data) => {
  console.log(data);
});
unsub();

// Publish an event
sdk.pubsub.emit("my-tile:updated", { value: 42 });
```

### sdk.sessions

Manage terminal sessions via the katulong API.

```js
// List all sessions
const sessions = await sdk.sessions.list();

// Create a new terminal session
const session = await sdk.sessions.create("my-session");

// Kill a session
await sdk.sessions.kill("my-session");
```

## Extension Lifecycle

```
Server startup:
  1. Scan ~/.katulong/tiles/ for directories with manifest.json + tile.js
  2. Register routes: GET /api/tile-extensions, GET /tiles/:name/*

Client boot:
  3. Fetch /api/tile-extensions → list of discovered extensions
  4. For each extension: import(/tiles/{name}/tile.js) → setup(sdk, options)
  5. Register returned factory in tile registry
  6. Extension types appear in the + menu
  7. Carousel restore runs (extension types now available)

User creates tile:
  8. Factory called with {} → TilePrototype
  9. tile.mount(container, ctx) → tile builds its DOM

Page reload:
  10. Extensions load first (step 3-6)
  11. Carousel reads sessionStorage → createTile(type, savedState)
  12. Factory called with saved state → TilePrototype restored
```

Extensions load **before** carousel restore so that saved extension tiles can be recreated. Unknown tile types during restore are skipped with a warning.

## Tile Context (ctx)

The `ctx` object passed to `mount()` is created by the carousel for each tile instance:

```js
{
  tileId: string,                  // Unique tile instance ID
  sendWs(msg): void,              // Send a WebSocket message to the server
  onWsMessage(type, handler): fn, // Subscribe to WS messages (returns unsubscribe)
  chrome: {
    toolbar: TileToolbar,          // Top bar (title, buttons)
    sidebar: TileSidebar,          // Left panel (navigation, lists)
    shelf: TileShelf,              // Bottom bar (status, input)
  },
}
```

### Chrome Zones

Chrome zones are optional UI regions around the tile content area. They collapse to zero size when empty.

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

**Toolbar** — horizontal bar at the top:
```js
ctx.chrome.toolbar.setTitle("My Tile");
ctx.chrome.toolbar.addButton({
  icon: "plus",           // Phosphor icon name
  label: "Add",           // Tooltip / accessibility
  position: "left",       // "left" or "right"
  onClick: () => { ... },
});
```

**Sidebar** — vertical panel on the left:
```js
ctx.chrome.sidebar.mount(myListElement);
ctx.chrome.sidebar.setWidth("180px");
ctx.chrome.sidebar.collapse();
ctx.chrome.sidebar.expand();
ctx.chrome.sidebar.unmount();  // call in tile.unmount()
```

**Shelf** — horizontal bar at the bottom:
```js
ctx.chrome.shelf.mount(myStatusBar);
ctx.chrome.shelf.setHeight("40px");
```

Always check `ctx?.chrome?.toolbar` before using chrome zones — they may not be available in all contexts (e.g., sub-tiles in a dashboard).

## Installing Community Tiles

```bash
# Clone a tile into the tiles directory
git clone https://github.com/someone/katulong-tile-foo ~/.katulong/tiles/foo

# Or create manually
mkdir -p ~/.katulong/tiles/my-tile

cat > ~/.katulong/tiles/my-tile/manifest.json << 'EOF'
{
  "name": "My Tile",
  "type": "my-tile",
  "icon": "star"
}
EOF

cat > ~/.katulong/tiles/my-tile/tile.js << 'EOF'
export default function setup(sdk, options) {
  return function createMyTile(opts = {}) {
    return {
      type: "my-tile",
      mount(el) { el.textContent = "Hello!"; },
      unmount() {},
      focus() {},
      blur() {},
      resize() {},
      getTitle() { return "My Tile"; },
      getIcon() { return "star"; },
    };
  };
}
EOF
```

No restart needed — the extension list is re-scanned on each request to `GET /api/tile-extensions`. New tiles appear in the `+` menu after a page refresh.

## Server-Side Architecture

Extension discovery and file serving are handled by `lib/tile-extensions.js`:

- **Discovery**: `discoverTileExtensions(dataDir)` scans `~/.katulong/tiles/` for directories with valid `manifest.json` + `tile.js`
- **Routes**: `createTileExtensionRoutes(ctx)` returns two route handlers:
  - `GET /api/tile-extensions` — returns JSON list of discovered extensions
  - `GET /tiles/:name/:path` — serves extension files with correct MIME types
- **Security**: Extension name validation (alphanumeric + hyphens/underscores), path traversal prevention (resolved path must start with extension directory), auth required for all routes

Client-side loading is handled by `public/lib/tile-extension-loader.js`:
- Fetches the extension list from `/api/tile-extensions`
- Dynamically imports each extension's `tile.js`
- Creates a namespaced SDK instance via `createTileSDK(type, deps)`
- Calls `setup(sdk, options)` and registers the returned factory

## Security

- Tiles run in the same origin as katulong (no sandbox/iframe isolation). They have full access to the DOM and the katulong APIs.
- Only install tiles from trusted sources. A malicious tile has the same access as katulong itself.
- Extension files are served behind authentication — unauthenticated requests are redirected to login.
- Extension file serving prevents path traversal attacks.
- Extension names are validated against `[a-zA-Z0-9_-]+`.

## Example: Plano (Notes Tile)

Plano is a notes tile that ships as an extension. It demonstrates the full SDK:

```
~/.katulong/tiles/plano/
├── manifest.json        — name, type, icon, optional Tala config
├── tile.js              — setup(sdk) → factory → TilePrototype
├── tala-editor.js       — <tala-editor> web component (rich text)
└── tala-md.js           — markdown ↔ HTML conversion functions
```

Key patterns:
- **Storage**: `sdk.storage.get("notes")` / `sdk.storage.set("notes", {...})` for localStorage persistence
- **Chrome**: toolbar title + buttons, sidebar for notes list
- **Web components**: dynamically imports `<tala-editor>` from its own `/tiles/plano/` directory
- **Fallback UI**: inline controls when chrome zones aren't available (e.g., in a dashboard sub-tile)
- **Serialize/restore**: saves `activeNoteId` so the open note survives page reload
