# katulong

A minimal web terminal with tmux-style session management. Three files, zero frameworks.

## Features

- **Named sessions** via URL — `/?s=myproject` connects to a session called "myproject"
- **Sessions persist** when you close the browser, like `tmux detach`
- **Shared sessions** — open the same URL in multiple windows to share a terminal
- **Session manager** — create, rename, delete sessions from a modal UI
- **Configurable shortcuts** — pinned keys in the toolbar, full list in a popup
- **Cmd/Option key support** — Cmd+Backspace (kill line), Option+Backspace (delete word), etc.
- **Mobile-friendly** — autocorrect disabled, touch-optimized buttons, virtual keyboard awareness

## Setup

```
npm install
npm start
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
| `PORT` | `3001` | Server port |
| `SHELL` | `/bin/zsh` | Shell to spawn |

## Architecture

```
server.js          — HTTP + WebSocket server, session lifecycle, REST API
public/index.html  — xterm.js terminal, session manager UI, shortcut bar
shortcuts.json     — user-configured keyboard shortcuts
```

Sessions are a `Map<name, { pty, outputBuffer, clients, alive }>`. PTYs are spawned lazily on first connect and persist until explicitly deleted. Output is buffered so reconnecting clients see recent history.

## License

MIT
