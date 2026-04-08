# katulong

[![Discord](https://img.shields.io/discord/1483879594619568291?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://dorkyrobot.com/discord)

<div align="center">

<img src="katulong.png" alt="Katulong mascot" width="300">

*Katulong* (kah-too-LONG) — Tagalog for *helper*.

</div>

A remote desktop experience for your server, delivered through the browser. Terminal, file browser, port proxy, drag-and-drop — everything you need to work on a remote machine as if you were sitting in front of it.

**Extensible by design.** Katulong's tile system lets you create custom UI surfaces — dashboards, previews, tools — alongside your terminals. Drop a folder in `~/.katulong/tiles/` and it shows up in the menu.

## What it does

Katulong runs on your server and serves a native-feeling workspace over HTTP + WebSocket. Open a browser on any device — phone, tablet, laptop — and you get:

- **Terminal** — Full xterm.js shell with tmux-backed sessions that survive restarts and reconnects
- **Tiles** — Pluggable UI containers: terminals, dashboards, web previews, custom HTML, or anything you build
- **File browser** — Browse, upload, download, and manage files on the remote host
- **Port proxy** — Access services running on the remote machine (dev servers, dashboards) through the browser
- **Drag and drop** — Drop files from your device into the terminal or file browser
- **Multi-session tabs** — Chrome-style tabs with drag reorder, tear-off to new window, and context menus
- **Clipboard bridge** — Copy/paste images and text between your device and the remote machine
- **Flippable cards** — Each tile has a front and back face with a 3D flip animation

```bash
katulong start
```

Open `https://your-machine:3001` from any device. That's it.

## Install

### One-line install (Linux, macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/dorky-robot/katulong/main/install.sh | sh
```

Works on Alpine, Debian/Ubuntu, RHEL/Fedora, and macOS. On macOS it detects Homebrew and uses the tap.

### Docker

Add to your Dockerfile:

```dockerfile
RUN KATULONG_VERSION=0.14.13 \
    curl -fsSL https://raw.githubusercontent.com/dorky-robot/katulong/v0.14.13/install.sh | sh

ENV PORT=3001
CMD ["katulong", "start", "--foreground"]
```

Mount a volume for auth state so passkeys and session tokens survive container restarts:

```bash
docker run -d -p 3001:3001 -v katulong-data:/root/.katulong your-image
```

### Homebrew (macOS)

```bash
brew install dorky-robot/katulong/katulong
katulong start
```

### Manual

```bash
git clone https://github.com/dorky-robot/katulong.git
cd katulong && npm install && npm link
```

## Quick start

```bash
katulong start                          # Start the server
katulong browse                         # Open in your default browser
katulong status                         # Check if it's running
katulong session create myapp --open    # Create session + open in browser
katulong logs                           # View logs
katulong update                         # Update to the latest version
katulong stop                           # Stop everything
```

### CLI commands

```bash
# Server
katulong start | stop | restart | status | logs | update

# Browser
katulong browse                         # Open localhost in browser

# Sessions
katulong session create <name> [--open] # Create (--open shows in browser)
katulong session list                   # List sessions
katulong session kill <name>            # Kill a session

# Messaging (inter-session pub/sub)
katulong pub <topic> <message>          # Publish to a topic
katulong sub <topic> [--once] [--json]  # Subscribe (streams to stdout)
katulong topics                         # List active topics
katulong notify <message>               # Send native notification

# Auth
katulong token create <name>            # Create setup token (shows QR code)
katulong apikey create <name>           # Create API key for external access
katulong credential list                # List registered passkeys

# Other
katulong info                           # System info
katulong service install                # Auto-start on login (macOS)
```

## Terminals as first-class cards

Katulong's UI is a carousel of terminal cards. Each card is a live tmux
session with its own xterm.js front face and a small status dashboard
on the back face — flip between them with a 3D animation.

```js
// From the browser console:
const { carousel } = window.__tiles;
const id = carousel.getFocusedCard();
carousel.flipCard(id);
```

Flipping to the back face shows the session's child processes, run
duration, and quick actions (kill, restart, copy output). When the
agent running inside the terminal finishes its work, the card
auto-flips to the dashboard after a short delay.

Multiple terminals in one view (the "cluster") and persistent
per-project crews (`{project}--{role}`) are the next step — see
`docs/dorkyrobot-stack.md`.

## Security

This application provides direct shell access to the host. Security isn't optional.

- **WebAuthn passkeys** — First device registers via passkey. Additional devices pair via QR code + PIN.
- **No passwords** — Identity is proven by cryptographic key, not a shared secret.
- **Localhost bypass** — Local connections auto-authenticate. Remote connections require a session cookie.
- **30-day sessions** — Server-side tokens, pruned on expiry. No tokens in URLs or localStorage.

## How it works

```
Any browser  <──WebSocket──>  Katulong server
                              ├── Terminal sessions (tmux)
                              ├── Tile system (pluggable UI)
                              ├── File browser
                              ├── Port proxy
                              └── Auth (WebAuthn)
```

Sessions live in tmux on the host. Restart the server, your sessions survive. The browser reconnects and replays the output buffer. Close your laptop, open your phone — same session, same scrollback.

### Touch-first design

Built for iPad and mobile from day one:

- Card carousel with swipe navigation between tiles
- Dedicated text input area (works with dictation/speech-to-text)
- Swipe arrow keys, pinned Esc/Tab buttons
- Floating shortcut island, draggable and auto-clamped to viewport
- PWA-ready — install as a full-screen app

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
| `KATULONG_DATA_DIR` | `~/.katulong` | Auth state, config, and tiles |

## Development

```bash
npm install           # Install dependencies
npm run dev           # Run server with auto-reload
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:e2e      # End-to-end tests (Playwright)
```

## License

MIT
