# katulong

> _Katulong_ (kah-too-LONG) means "helper" in Tagalog—your always-ready terminal assistant.

Your terminal, everywhere. Access your shell sessions from any device—desktop browser, phone, tablet—over LAN or the internet. Need a raw terminal? SSH directly into your sessions. Your work follows you.

## Screenshots

<div align="center">

### Terminal Interface

<img src="docs/assets/images/terminal-main.png" alt="Main terminal interface" width="45%">
<img src="docs/assets/images/terminal-mobile.png" alt="Mobile terminal with touch controls" width="45%">

### Device Management & Security

<img src="docs/assets/images/settings.png" alt="Settings panel" width="30%">
<img src="docs/assets/images/devices.png" alt="Device management" width="30%">
<img src="docs/assets/images/pairing-flow.png" alt="Secure device pairing" width="30%">

### Customization

<img src="docs/assets/images/shortcuts-editor.png" alt="Shortcuts editor" width="60%">

</div>

## Why Katulong?

**Take your terminal anywhere.** Start a build on your laptop, check progress from your phone on the couch, finish debugging via SSH from your desktop. Same sessions, any device.

- **Browser-based** — Works on desktop, mobile, any device with a browser. No app store needed.
- **LAN + Internet** — Access over your local network or expose securely over the internet.
- **SSH access** — Prefer a raw terminal? SSH directly into any session.
- **Secure device pairing** — WebAuthn + QR code pairing. Your sessions, your devices only.
- **Sessions persist** — Daemon owns PTYs. Restart the server, your sessions survive.

## Installation

### Homebrew (macOS)

```bash
# Add the tap
brew tap dorky-robot/katulong

# Install
brew install katulong

# Start Katulong
katulong start

# Or use brew services for auto-start on login
brew services start katulong
```

**⚠️ macOS 26.x beta users:** If you see "Xcode 26.0 required" error, use this instead:

```bash
curl -fsSL https://raw.githubusercontent.com/dorky-robot/homebrew-katulong/master/install.sh | bash
```

### Manual Installation

```bash
git clone https://github.com/dorky-robot/katulong.git
cd katulong
npm install
npm link  # Makes 'katulong' command available globally
```

## Quick Start

```bash
# Start Katulong
katulong start

# Check status
katulong status

# Open in browser
katulong open

# View logs
katulong logs

# Stop Katulong
katulong stop
```

For detailed CLI usage, run `katulong --help`.

## Features

### Mobile-First Terminal
- **Full-screen text input** — Dedicated textarea for writing commit messages, documentation, or long-form text. Works with your phone's built-in speech-to-text.
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

## Development

```bash
# Install dependencies
npm install

# Run both daemon and server with auto-reload
npm run dev

# Or run separately:
npm run daemon  # Terminal 1
npm start       # Terminal 2
```

Open `http://localhost:3001` in a browser.

For production deployment, use the `katulong` CLI (see Installation above).

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
