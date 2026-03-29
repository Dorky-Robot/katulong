# Architecture

## System Overview

```
Browser                               Server (Node.js)
├─ Tile Carousel                      ├─ Tile Extensions (discovery + file serving)
│  ├─ Terminal tiles ──topic:sess──►  ├─ Session Manager ── tmux sessions
│  ├─ Extension tiles                 │                      PTY processes
│  └─ Chrome zones                    │                      ring buffers
├─ Tile SDK (storage, ws, pubsub)     ├─ Topic Broker (pub/sub event bus)
├─ WebSocket ─────────────────────►   ├─ WebSocket Manager
├─ HTTP REST ─────────────────────►   ├─ Routes (auth, sessions, config, files)
│                                     ├─ Auth middleware (WebAuthn)
│                                     ├─ Static files, file browser, port proxy
└─ Tunnel (Cloudflare/ngrok) ── HTTPS─┘
```

Katulong is a tile platform. The server manages tile extensions, terminal sessions (via tmux), and a topic-based pub/sub system. The browser renders tiles in a carousel (tablet/phone) or tab layout (desktop). Each tile type — terminal, notes, dashboard, custom — follows the same lifecycle and communicates through the same event bus.

## Core Concepts

### Tiles

The primary abstraction. Every piece of functionality is a tile: terminals, notes, file browsers, dashboards. Tiles implement a standard interface (`mount`, `unmount`, `focus`, `blur`, `resize`, `serialize`) and are managed by the carousel.

- **Built-in:** Terminal tile (ships with katulong source)
- **Extensions:** Everything else lives in `~/.katulong/tiles/` — discovered at startup, loaded via the Tile SDK

### Tile SDK

The interface between extension tiles and the platform. Each extension gets a namespaced SDK instance with:

| API | Purpose |
|-----|---------|
| `sdk.storage` | Per-tile localStorage (namespaced by type) |
| `sdk.platform` | Device detection, dark mode, version |
| `sdk.api` | Authenticated HTTP client |
| `sdk.toast` | Notifications |
| `sdk.ws` | WebSocket send/subscribe |
| `sdk.pubsub` | In-browser event bus |
| `sdk.sessions` | Terminal session management |

### Topic Broker

Server-side pub/sub. Terminal sessions are topics (`session:{name}`), but any service can publish to any topic. Tiles subscribe via WebSocket. This is the backbone for tile orchestration — one tile emits an event, another reacts.

### Chrome Zones

Per-tile UI regions (toolbar, sidebar, shelf) that tiles populate via `ctx.chrome`. Zones collapse to zero size when empty. This lets tiles have consistent controls without each tile reimplementing a toolbar.

## Server Components

| Module | Responsibility |
|--------|---------------|
| `server.js` | HTTP + WebSocket server, startup, shutdown, route wiring |
| `lib/tile-extensions.js` | Discover extensions in `~/.katulong/tiles/`, serve files |
| `lib/session-manager.js` | Terminal session lifecycle via tmux control mode |
| `lib/session.js` | Session class, tmux helpers, RingBuffer |
| `lib/ws-manager.js` | WebSocket connection management, ping/pong heartbeat |
| `lib/transport-bridge.js` | Bidirectional bridge: WebSocket to session I/O |
| `lib/topic-broker.js` | Pub/sub topic management and message delivery |
| `lib/routes.js` | HTTP route registration and middleware composition |
| `lib/auth.js` | WebAuthn registration/login, session tokens, passkey storage |
| `lib/access-method.js` | Detect access method: localhost, LAN, or internet |
| `lib/config.js` | Instance configuration (name, icon, colors, port-proxy) |
| `lib/file-browser.js` | File system browsing, upload, download |
| `lib/port-proxy.js` | Proxy WebSocket/HTTP to localhost ports |
| `lib/static-files.js` | Static file serving with path traversal protection |
| `lib/plugin-loader.js` | Server-side plugin discovery |
| `lib/log.js` | Structured JSON logging |

## Client Architecture

### Frontend Modules

**Tile System**: `tile-registry.js`, `tile-sdk-impl.js`, `tile-extension-loader.js`, `tile-chrome.js`, `card-carousel.js`

**Tiles**: `tiles/terminal-tile.js` (built-in)

**Terminal**: `terminal-pool.js`, `terminal-input-filter.js`, `terminal-keyboard.js`, `input-sender.js`, `scroll-utils.js`

**Networking**: `websocket-connection.js`, `network-monitor.js`, `api-client.js`

**UI**: `shortcut-bar.js`, `window-tab-set.js`, `session-list-component.js`, `modal.js`, `toast.js`

**Input**: `paste-handler.js`, `drag-drop.js`, `image-upload.js`, `joystick.js`, `key-mapping.js`

**Platform**: `device.js`, `viewport-manager.js`, `theme-manager.js`

## REST API

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/status` | Setup status and access method |
| POST | `/auth/register/options` | Generate WebAuthn registration challenge |
| POST | `/auth/register/verify` | Verify registration and create session |
| POST | `/auth/login/options` | Generate WebAuthn login challenge |
| POST | `/auth/login/verify` | Verify login credential |
| POST | `/auth/logout` | Invalidate session |

### Tile Extensions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tile-extensions` | List discovered extensions |
| GET | `/tiles/:name/:path` | Serve extension files (JS, CSS, JSON) |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List managed sessions |
| POST | `/sessions` | Create session |
| PUT | `/sessions/:name` | Rename session |
| DELETE | `/sessions/:name` | Kill or detach session |
| GET | `/tmux-sessions` | List unmanaged tmux sessions |

### Config

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get all instance config |
| PUT | `/api/config/instance-name` | Set instance name |
| PUT | `/api/config/instance-icon` | Set instance icon |
| PUT | `/api/config/toolbar-color` | Set toolbar color |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/` | SPA frontend |
| POST | `/upload` | Upload image |
| GET | `/shortcuts` | Load user shortcuts |

## WebSocket Protocol

### Client to Server

| Type | Payload | Description |
|------|---------|-------------|
| `attach` | `{ session, cols, rows }` | Attach to a terminal session |
| `resize` | `{ cols, rows }` | Resize terminal |
| `subscribe` | `{ topic }` | Subscribe to a pub/sub topic |
| `unsubscribe` | `{ topic }` | Unsubscribe from a topic |
| (raw text) | (terminal input) | Input sent via transport bridge |

### Server to Client

| Type | Payload | Description |
|------|---------|-------------|
| `attached` | — | Session attached successfully |
| `output` | `{ data }` | Terminal output (topic-based) |
| `exit` | — | Shell exited |
| `session-removed` | — | Session was deleted |
| `session-renamed` | `{ name }` | Session was renamed |
| `server-draining` | — | Server shutting down |
| `reload` | — | Force browser reload |

## Data Directory

All persistent state lives in `~/.katulong/` (configurable via `KATULONG_DATA_DIR`):

```
~/.katulong/
  tiles/                  ← installed tile extensions
    plano/
      manifest.json
      tile.js
  credentials/            ← WebAuthn credential storage
  sessions/               ← session token storage
  setup-tokens/           ← setup token storage
  uploads/                ← uploaded files
  config.json             ← instance configuration
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server listen port |
| `KATULONG_BIND_HOST` | `127.0.0.1` | Bind address |
| `KATULONG_DATA_DIR` | `~/.katulong` | Persistent data directory |
| `SHELL` | `/bin/zsh` | Shell binary for sessions |
| `LOG_LEVEL` | `info` | Minimum log level |

## Security Architecture

See [Security](security/index.md) for the full security model. Key points:

- WebAuthn passkeys — no passwords
- Localhost auth bypass (socket address + Host/Origin header check)
- 30-day session tokens with HttpOnly, SameSite=Lax cookies
- CSRF protection on state-mutating endpoints
- Origin validation on WebSocket upgrade
- All frontend dependencies self-hosted in `public/vendor/`
- Tile extension files served behind authentication with path traversal protection
