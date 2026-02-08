# katulong

> **Warning:** This project is highly experimental. Expect breaking changes, rough edges, and missing features.

A self-hosted web terminal designed for mobile-first development. Built for the modern workflow where writing commit messages, documentation, and code reviews is as critical as writing code itself.

## Why Katulong?

Modern development isn't just coding—it's communicating. You write commit messages, pull request descriptions, code reviews, documentation, and chat messages. Most mobile terminals treat prose as an afterthought. Katulong makes long-form writing on mobile a first-class experience.

## Features

### Mobile-First Terminal
- **Dictation mode** — Full-screen composition area for writing commit messages, documentation, or any long-form text. Supports voice dictation and image attachments.
- **Swipe navigation** — Dedicated touch zone for arrow keys. Swipe left/right/up/down to navigate without obscuring the terminal.
- **Smart keyboard handling** — Autocorrect, autocomplete, and autocapitalize disabled to prevent interference. Virtual keyboard detection keeps the terminal in view.
- **PWA-ready** — Install as a full-screen app. Works offline, no app store needed.

### Session Management
- **Named sessions** via URL — `/?s=myproject` connects to a session called "myproject"
- **Sessions survive restarts** — daemon owns PTYs, so restarting the web server preserves all sessions
- **Shared sessions** — open the same URL in multiple windows to share a terminal
- **Session manager** — create, rename, delete sessions from a modal UI

### Power User Features
- **Configurable shortcuts** — pinned keys in the toolbar, full list in a popup
- **Cmd/Option key support** — Cmd+Backspace (kill line), Option+Backspace (delete word), etc.
- **Touch-optimized toolbar** — Essential keys always accessible, no hunting for special characters

## Setup

```
npm install
```

Start the daemon (owns PTY sessions):

```
npm run daemon
```

In another terminal, start the UI server:

```
npm start
```

Or run both together:

```
npm run dev
```

Open `http://localhost:3001` in a browser.

## Usage

- Visit `/` to connect to the "default" session
- Visit `/?s=name` to connect to a named session (created automatically)
- Click the session button in the toolbar to manage sessions
- Click the keyboard icon to access shortcuts

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions` | List all sessions |
| POST | `/sessions` | Create a session `{ "name": "..." }` |
| PUT | `/sessions/:name` | Rename a session `{ "name": "..." }` |
| DELETE | `/sessions/:name` | Kill and remove a session |
| GET | `/shortcuts` | Get shortcut config |
| PUT | `/shortcuts` | Update shortcut config |

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | UI server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
| `KATULONG_SOCK` | `/tmp/katulong-daemon.sock` | Unix socket path for daemon IPC |

## Architecture

```
Browser  <--WebSocket-->  UI Server (server.js)  <--Unix Socket-->  Daemon (daemon.js)
                          HTTP + static files                       PTY sessions
                          Live-reload watcher                       Output buffers
                                                                    Shortcuts I/O
```

- **`daemon.js`** — Manages PTY sessions, reads/writes shortcuts, communicates over a Unix domain socket using newline-delimited JSON
- **`server.js`** — HTTP + WebSocket server that proxies all session/shortcut operations to the daemon
- **`public/index.html`** — xterm.js terminal, session manager UI, shortcut bar
- **`shortcuts.json`** — User-configured keyboard shortcuts

The daemon owns all PTY processes. The UI server is stateless — you can restart it freely without losing terminal sessions. On restart, the browser's reconnect logic kicks in and the daemon replays the output buffer.

## License

MIT
