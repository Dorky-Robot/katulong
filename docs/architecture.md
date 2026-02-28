# Architecture

```
Phone browser  ──WebSocket──┐
                              ├── UI Server (server.js) ──Unix Socket──  Daemon (daemon.js)
Desktop browser ──WebSocket──┘                                           PTY sessions
                                                                         Output buffers
SSH client ─────────────────────SSH server──────────────────────────────┘
```

The daemon owns the PTY sessions. The web server is stateless — restart it freely, your sessions survive. The browser reconnects and the daemon replays the output buffer. You pick up exactly where you left off.

## Components

| Component | Description |
|---|---|
| **`daemon.js`** | Long-lived process that owns PTY sessions. Communicates over a Unix domain socket via newline-delimited JSON. |
| **`server.js`** | HTTP/HTTPS + WebSocket server. Routes, auth middleware, daemon IPC, device pairing. |
| **`public/index.html`** | SPA frontend. xterm.js terminal, shortcut bar, settings, inline pairing wizard. |
| **`lib/auth.js`** | WebAuthn registration/login, session token management, passkey storage. |
| **`lib/tls.js`** | Auto-generated CA + server certificates for LAN HTTPS. |
| **`lib/p2p.js`** | WebRTC DataChannel for low-latency terminal I/O. |
| **`lib/ssh.js`** | SSH server bridging native terminals to daemon PTY sessions. |

The daemon owns all PTY processes. The UI server is stateless — restart it freely without losing terminal sessions. On restart, the browser's reconnect logic kicks in and the daemon replays the output buffer.

## REST API

| Method | Endpoint | Description |
|---|---|---|
| GET | `/sessions` | List all sessions |
| POST | `/sessions` | Create a session `{ "name": "..." }` |
| PUT | `/sessions/:name` | Rename a session `{ "name": "..." }` |
| DELETE | `/sessions/:name` | Kill and remove a session |
| GET | `/shortcuts` | Get shortcut config |
| PUT | `/shortcuts` | Update shortcut config |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | UI server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
| `KATULONG_SOCK` | `/tmp/katulong-daemon.sock` | Unix socket path for daemon IPC |
