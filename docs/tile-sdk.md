# Tile SDK

The Tile SDK is the interface between custom tiles and the katulong platform. Tile authors create a directory in `~/.katulong/tiles/` with a manifest and a JS module. Katulong discovers them at startup and makes them available in the `+` menu.

## Directory Structure

```
~/.katulong/tiles/
  my-tile/
    manifest.json       — metadata (required)
    tile.js             — tile implementation (required)
    style.css           — custom styles (optional, auto-injected)
    icon.svg            — custom icon (optional, overrides manifest icon)
    README.md           — documentation (optional, for humans)
```

Built-in tiles live in the katulong source at `public/lib/tiles/` and follow the same interface. The `~/.katulong/tiles/` directory is for user-installed and community tiles.

## manifest.json

```json
{
  "name": "My Tile",
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
| `textarea` | Multi-line text |

Config values are passed to the tile's `setup()` function as `options`.

## tile.js

The main module. Must export a default function that receives the SDK and returns a `TilePrototype`.

```js
export default function setup(sdk, options) {
  // options = config values from the manifest's config fields
  // sdk = katulong platform APIs

  let el = null;

  return {
    type: "my-tile",

    mount(container, ctx) {
      el = container;

      // Use chrome zones
      ctx.chrome.toolbar.setTitle(options.title || "My Tile");
      ctx.chrome.toolbar.addButton({
        icon: "arrow-clockwise",
        label: "Refresh",
        position: "right",
        onClick: () => refresh(),
      });

      // Build your UI
      const div = document.createElement("div");
      div.textContent = "Hello from my tile!";
      container.appendChild(div);
    },

    unmount() {
      el = null;
    },

    focus() {},
    blur() {},
    resize() {},
    getTitle() { return options.title || "My Tile"; },
    getIcon() { return "browser"; },
    serialize() { return { ...options }; },
  };
}
```

## SDK Reference

The `sdk` object passed to `setup()` provides access to katulong platform APIs.

### sdk.sessions

Manage terminal sessions.

```js
// Create a new terminal session
const session = await sdk.sessions.create("my-session");

// List all sessions
const sessions = await sdk.sessions.list();

// Kill a session
await sdk.sessions.kill("my-session");

// Rename a session
await sdk.sessions.rename("old-name", "new-name");
```

### sdk.pubsub

Subscribe to and publish katulong events.

```js
// Subscribe to an event
const unsub = sdk.pubsub.on("session:output", (data) => {
  console.log(data.session, data.text);
});

// Unsubscribe
unsub();

// Publish a custom event
sdk.pubsub.emit("my-tile:updated", { value: 42 });
```

#### Built-in Events

| Event | Payload | Description |
|-------|---------|-------------|
| `session:created` | `{ name }` | New terminal session created |
| `session:removed` | `{ name }` | Session killed/removed |
| `session:renamed` | `{ oldName, newName }` | Session renamed |
| `session:output` | `{ session, data }` | Terminal output (subscribed sessions) |
| `tile:created` | `{ id, type }` | New tile added to carousel |
| `tile:removed` | `{ id }` | Tile removed from carousel |
| `tile:flipped` | `{ id, flipped }` | Card flipped |
| `tile:focused` | `{ id }` | Tile became focused |
| `connection:opened` | `{}` | WebSocket connected |
| `connection:closed` | `{}` | WebSocket disconnected |

### sdk.ws

Low-level WebSocket access.

```js
// Send a message to the server
sdk.ws.send({ type: "my-message", data: "hello" });

// Listen for messages from the server
const unsub = sdk.ws.on("my-response", (msg) => {
  console.log(msg);
});
```

### sdk.storage

Per-tile persistent key/value store. Data persists across page reloads in `localStorage`, namespaced by tile type.

```js
// Store a value
sdk.storage.set("lastUrl", "https://example.com");

// Retrieve a value
const url = sdk.storage.get("lastUrl");

// Remove a value
sdk.storage.remove("lastUrl");

// List all keys
const keys = sdk.storage.keys();
```

### sdk.terminal

Spawn and interact with headless terminal sessions (not visible in the carousel). Useful for tiles that need to run commands and capture output.

```js
// Run a command and get the output
const output = await sdk.terminal.exec("git status");

// Spawn a persistent background session
const session = await sdk.terminal.spawn("build-watcher");

// Write to a session
sdk.terminal.write("build-watcher", "npm run build\n");

// Read output (streaming)
sdk.terminal.onOutput("build-watcher", (data) => {
  console.log(data);
});
```

### sdk.toast

Show toast notifications.

```js
sdk.toast("Build succeeded!", { duration: 3000 });
sdk.toast("Deploy failed", { type: "error" });
```

### sdk.tiles

Manage tiles in the carousel.

```js
// Create and add a tile
const tile = sdk.tiles.create("html", { title: "Status", html: "<h1>OK</h1>" });
sdk.tiles.add("status-1", tile);

// Remove a tile
sdk.tiles.remove("status-1");

// Flip a tile
sdk.tiles.flip("my-session");

// Set a back face on a tile
sdk.tiles.setBack("my-session", sdk.tiles.create("html", { html: "..." }));

// Get the focused tile ID
const focused = sdk.tiles.focused();

// List all tile IDs
const all = sdk.tiles.list();
```

### sdk.api

HTTP client for katulong's REST API. Automatically handles auth cookies.

```js
// GET
const data = await sdk.api.get("/sessions");

// POST
const result = await sdk.api.post("/sessions", { name: "new-session" });

// DELETE
await sdk.api.delete("/sessions/my-session");
```

### sdk.platform

Platform information.

```js
sdk.platform.isIPad;      // true on iPad
sdk.platform.isPhone;     // true on phone
sdk.platform.isDesktop;   // true on desktop
sdk.platform.isDark;      // true if dark theme active
sdk.platform.version;     // katulong version string
```

## Built-in Tile Templates

These ship with katulong and are always available:

### Terminal

Plain terminal session. The default when clicking "+" > "New Terminal".

```json
{
  "name": "Terminal",
  "icon": "terminal-window",
  "config": []
}
```

### Dev Terminal

Terminal with toolbar showing session name and flip button.

```json
{
  "name": "Dev Terminal",
  "icon": "terminal-window",
  "config": []
}
```

### Dashboard

Configurable grid of sub-tiles.

```json
{
  "name": "Dashboard",
  "icon": "squares-four",
  "config": [
    { "key": "cols", "label": "Columns", "type": "number", "default": 2 },
    { "key": "rows", "label": "Rows", "type": "number", "default": 1 }
  ]
}
```

### Web Preview

Iframe tile for previewing web apps.

```json
{
  "name": "Web Preview",
  "icon": "browser",
  "config": [
    { "key": "url", "label": "URL", "type": "text", "required": true }
  ]
}
```

### HTML View

Renders HTML content. Useful as a back face or for custom displays.

```json
{
  "name": "HTML View",
  "icon": "code",
  "config": [
    { "key": "html", "label": "HTML", "type": "textarea" }
  ]
}
```

## Tile Lifecycle

```
1. Discovery: katulong scans ~/.katulong/tiles/ at startup
2. Registration: each tile's manifest is read, tile.js is registered in the registry
3. Creation: user clicks "+" > tile name, fills in config fields
4. Instantiation: setup(sdk, options) is called, returns TilePrototype
5. Mount: tile.mount(container, ctx) — tile builds its DOM
6. Active use: focus/blur/resize called as user navigates
7. Unmount: tile.unmount() — tile cleans up
8. Persistence: tile.serialize() saves state for page reload
```

## Installing Community Tiles

```bash
# Clone a tile into the tiles directory
git clone https://github.com/someone/katulong-tile-foo ~/.katulong/tiles/foo

# Or just create the directory manually
mkdir -p ~/.katulong/tiles/my-tile
cat > ~/.katulong/tiles/my-tile/manifest.json << 'EOF'
{ "name": "My Tile", "icon": "star" }
EOF
cat > ~/.katulong/tiles/my-tile/tile.js << 'EOF'
export default function setup(sdk, options) {
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
}
EOF

# Restart katulong to pick up the new tile
katulong restart
```

## Security

- Tiles run in the same origin as katulong (no sandbox/iframe isolation). They have full access to the DOM and the katulong APIs.
- Only install tiles from trusted sources. A malicious tile has the same access as katulong itself.
- The `sdk.terminal.exec()` function runs commands in the host terminal — treat it like shell access.
- Future: consider adding a permissions system where tiles declare what APIs they need and the user approves on install.
