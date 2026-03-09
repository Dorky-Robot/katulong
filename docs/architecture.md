# Architecture

```
Phone browser  ──WebSocket──┐
                              ├── Server (server.js) ── tmux sessions
Desktop browser ──WebSocket──┘   Session manager         PTY processes
                                 Auth middleware          Output buffers
```

Sessions are backed by tmux. Restart the server freely — your sessions survive. The browser reconnects and replays the output buffer. You pick up exactly where you left off.

## Components

| Component | Description |
|---|---|
| **`server.js`** | HTTP + WebSocket server. Routes, auth middleware, session management. |
| **`lib/session-manager.js`** | Terminal session lifecycle via tmux control mode. Runs in-process with the server. |
| **`lib/session.js`** | Session class, tmux helpers, RingBuffer. |
| **`public/index.html`** | SPA frontend. xterm.js terminal, shortcut bar, settings, inline pairing wizard. |
| **`lib/auth.js`** | WebAuthn registration/login, session token management, passkey storage. |

Sessions are managed via tmux control mode. The session manager runs in the server process — no separate daemon or IPC needed.

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
| `PORT` | `3001` | Server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
