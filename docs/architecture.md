# Architecture

## System Overview

```
Browser (xterm.js)                    Server (Node.js)
├─ WebSocket ──────────────────────── ws-manager.js ── session-manager.js ── tmux sessions
├─ WebRTC DataChannel (LAN) ──────── p2p.js            │                      PTY processes
├─ HTTP REST ──────────────────────── routes.js         │                      ring buffers
│                                     auth middleware    transport-bridge.js
│                                     static-files.js
│                                     file-browser.js
│                                     port-proxy.js
└─ Tunnel (ngrok/CF) ─── HTTPS ───┘
```

Sessions are backed by tmux. Restart the server freely — your sessions survive. The browser reconnects and replays the output buffer.

## Server Components

| Module | Responsibility |
|--------|---------------|
| `server.js` | HTTP + WebSocket server, startup, shutdown, route wiring |
| `lib/session-manager.js` | Terminal session lifecycle via tmux control mode |
| `lib/session.js` | Session class, tmux helpers, RingBuffer, octal unescape |
| `lib/ws-manager.js` | WebSocket connection management, ping/pong heartbeat |
| `lib/transport-bridge.js` | Bidirectional bridge: WebSocket and DataChannel to session I/O |
| `lib/routes.js` | HTTP route registration and middleware composition |
| `lib/auth.js` | WebAuthn registration/login, session tokens, passkey storage |
| `lib/auth-handlers.js` | Auth route handlers (register, login, logout, revoke) |
| `lib/auth-state.js` | AuthState value type with migration methods |
| `lib/access-method.js` | Detect access method: localhost, LAN, or internet |
| `lib/http-util.js` | Cookie parsing, public path allowlist, session cookies, challenge store |
| `lib/request-util.js` | Request body reading with size limits |
| `lib/config.js` | Instance configuration (name, icon, colors, port-proxy) |
| `lib/shortcuts.js` | User shortcut config persistence |
| `lib/file-browser.js` | File system browsing, upload, download, mkdir, rename, delete |
| `lib/port-proxy.js` | Proxy WebSocket/HTTP to localhost ports on the host |
| `lib/p2p.js` | WebRTC DataChannel server-side peer (node-datachannel) |
| `lib/lan.js` | mDNS advertisement and LAN IP discovery |
| `lib/static-files.js` | Static file serving from `public/` with path traversal protection |
| `lib/credential-lockout.js` | Credential-level lockout after failed login attempts |
| `lib/rate-limit.js` | Per-IP rate limiting for auth endpoints |
| `lib/env-config.js` | Environment variable parsing and defaults |
| `lib/env-filter.js` | Filter sensitive env vars from PTY environments |
| `lib/session-name.js` | Session name validation and generation |
| `lib/log.js` | Structured JSON logging |
| `lib/result.js` | Result type for error handling |
| `lib/websocket-validation.js` | Origin validation for WebSocket upgrades |

## REST API

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/status` | Setup status and access method (CORS-enabled) |
| POST | `/auth/register/options` | Generate WebAuthn registration challenge |
| POST | `/auth/register/verify` | Verify registration and create session |
| POST | `/auth/login/options` | Generate WebAuthn login challenge |
| POST | `/auth/login/verify` | Verify login credential (rate-limited) |
| POST | `/auth/logout` | Invalidate session (CSRF-protected) |
| POST | `/auth/revoke-all` | Revoke all sessions (CSRF-protected) |

### Credentials and Tokens

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/credentials` | List registered credentials |
| DELETE | `/api/credentials/:id` | Revoke a credential |
| GET | `/api/tokens` | List setup tokens |
| POST | `/api/tokens` | Create setup token (7-day TTL) |
| DELETE | `/api/tokens/:id` | Delete token (optionally revoke linked credential) |
| PATCH | `/api/tokens/:id` | Rename a token |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List managed sessions |
| POST | `/sessions` | Create session (optional `copy-from`) |
| PUT | `/sessions/:name` | Rename session |
| DELETE | `/sessions/:name` | Kill or detach session (`action=detach`) |
| GET | `/tmux-sessions` | List unmanaged tmux sessions |
| POST | `/tmux-sessions/adopt` | Adopt external tmux session |
| DELETE | `/tmux-sessions/:name` | Kill external tmux session |

### Config

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get all instance config |
| PUT | `/api/config/instance-name` | Set instance name |
| PUT | `/api/config/instance-icon` | Set instance icon |
| PUT | `/api/config/toolbar-color` | Set toolbar color |
| PUT | `/api/config/port-proxy-enabled` | Toggle port proxy |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (diagnostic details for authenticated users) |
| GET | `/` | SPA frontend with CSRF token injection |
| GET | `/login` | Login page |
| POST | `/upload` | Upload image (max 10 MB, copies to macOS clipboard) |
| GET | `/shortcuts` | Load user shortcuts |
| PUT | `/shortcuts` | Save user shortcuts (CSRF-protected) |
| GET | `/manifest.json` | PWA manifest |
| GET | `/sw.js` | Service worker |

## WebSocket Protocol

### Client to Server

| Type | Payload | Description |
|------|---------|-------------|
| `attach` | `{ session, cols, rows }` | Attach to a terminal session |
| `resize` | `{ cols, rows }` | Resize terminal |
| (raw text) | (terminal input) | Input sent via transport bridge |
| `p2p-signal` | `{ data }` | WebRTC signaling |

### Server to Client

| Type | Payload | Description |
|------|---------|-------------|
| `attached` | — | Session attached successfully |
| `switched` | `{ session }` | Session switch confirmed |
| `output` | `{ data }` | Terminal output |
| `exit` | — | Shell exited |
| `session-removed` | — | Current session was deleted |
| `session-renamed` | `{ name }` | Current session was renamed |
| `credential-registered` | — | New device registered |
| `credential-removed` | — | Credential revoked |
| `p2p-signal` | `{ data }` | WebRTC signaling |
| `p2p-ready` | — | DataChannel ready |
| `p2p-lan-candidates` | `{ addresses }` | Server LAN IPs |
| `p2p-closed` | — | DataChannel closed |
| `server-draining` | — | Server shutting down |
| `reload` | — | Force browser reload |

## P2P Progressive Enhancement

WebSocket is always the baseline transport. When the client is on the same LAN:

1. Client creates a WebRTC peer (initiator) after `attached` message
2. ICE candidates exchanged as `p2p-signal` messages over WebSocket
3. DataChannel opens — terminal I/O flows directly (lower latency)
4. If DataChannel closes, falls back to WebSocket with no interruption

No STUN/TURN servers — LAN-only by design. See [P2P Progressive Enhancement](p2p-progressive-enhancement.md).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server listen port |
| `KATULONG_BIND_HOST` | `127.0.0.1` | Bind address |
| `KATULONG_DATA_DIR` | `~/.katulong` | Persistent data directory |
| `SHELL` | `/bin/zsh` | Shell binary for sessions |
| `NODE_ENV` | `production` | Runtime environment |
| `LOG_LEVEL` | `info` | Minimum log level |
| `DRAIN_TIMEOUT` | `30000` | Graceful shutdown timeout (ms) |
| `HOME` | system home | Initial cwd for sessions |

## Frontend Modules

34 modules in `public/lib/` organized by concern:

**Terminal**: `terminal-pool.js`, `terminal-input-filter.js`, `terminal-keyboard.js`, `input-sender.js`, `scroll-utils.js`

**Networking**: `websocket-connection.js`, `p2p-manager.js`, `network-monitor.js`, `api-client.js`

**UI Components**: `shortcut-bar.js`, `shortcuts-components.js`, `tab-manager.js`, `window-tab-set.js`, `session-list-component.js`, `token-list-component.js`, `token-form.js`, `dictation-modal.js`, `modal.js`, `list-renderer.js`, `component.js`

**Input Handling**: `paste-handler.js`, `drag-drop.js`, `image-upload.js`, `joystick.js`, `key-mapping.js`, `pull-to-refresh.js`

**State**: `store.js`, `stores.js`

**Platform**: `device.js`, `viewport-manager.js`, `theme-manager.js`, `utils.js`, `webauthn-errors.js`, `settings-handlers.js`

## tmux Integration

Katulong uses tmux control mode (`tmux -u -C attach-session -d -t <name>`) for session I/O:

- **Control mode**: stdout carries `%output` protocol lines with octal-escaped terminal data
- **Input**: sent via `send-keys -H` (hex-encoded) to avoid keybinding conflicts
- **Resize**: `refresh-client -C WxH` + `resize-window` for control and regular clients
- **DA stripping**: xterm.js query responses (DA1, DA2, CPR) are filtered from input to prevent tmux keybinding triggers
- **Output dispatch**: each `%output` line is dispatched immediately to connected clients — xterm.js handles its own internal write buffering

## Security Architecture

See [Security](security/index.md) for the full security model. Key points:

- WebAuthn passkeys — no passwords
- Localhost auth bypass (socket address + Host/Origin header check)
- 30-day session tokens with HttpOnly, SameSite=Lax cookies
- CSRF protection on state-mutating endpoints
- Rate limiting and credential lockout on login
- Origin validation on WebSocket upgrade
- 1 MB body limit on all public auth endpoints
- All frontend dependencies self-hosted in `public/vendor/`
