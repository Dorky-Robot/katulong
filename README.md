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

## Tiles

Katulong's UI is built on a **tile system** — each card in the carousel is a generic container that can hold anything. Terminals are just one tile type. The `+` menu lets you create different tile types:

- **Terminal** — tmux-backed shell session
- **HTML View** — custom HTML content
- **Dashboard** — configurable grid of sub-tiles

### Flippable cards

Every tile has a front and back face. Flip between them with a 3D animation — terminal on the front, dashboard on the back.

```js
// From the browser console:
const { carousel, createTile } = window.__tiles;
const id = carousel.getFocusedCard();

// Set a back face and flip
carousel.setBackTile(id, createTile("html", {
  title: "Status",
  html: "<h1>All systems go</h1>"
}));
carousel.flipCard(id);
```

### Chrome zones

Each tile has optional chrome areas that content can populate:

```
┌─────────────────────────────────┐
│ [toolbar]                    ⟳  │
├────────┬────────────────────────┤
│[sidebar]│     [content]         │
├────────┴────────────────────────┤
│ [shelf]                         │
└─────────────────────────────────┘
```

Zones collapse when empty — a plain terminal uses none and looks identical to before.

### Create your own tiles

Drop a folder in `~/.katulong/tiles/` with a `manifest.json` and a `tile.js`:

```
~/.katulong/tiles/my-tile/
  manifest.json    — name, icon, config fields
  tile.js          — implements the tile interface
  style.css        — optional custom styles
```

**manifest.json:**
```json
{
  "name": "My Tile",
  "description": "A custom tile",
  "icon": "star",
  "config": [
    { "key": "url", "label": "URL", "type": "text", "required": true }
  ]
}
```

**tile.js:**
```js
export default function setup(sdk, options) {
  return {
    type: "my-tile",
    mount(el, ctx) {
      el.innerHTML = `<h1>Hello from ${options.url}</h1>`;
      ctx.chrome.toolbar.setTitle("My Tile");
      ctx.chrome.toolbar.addButton({
        icon: "arrow-clockwise",
        label: "Refresh",
        position: "right",
        onClick: () => refresh(),
      });
    },
    unmount() {},
    focus() {},
    blur() {},
    resize() {},
    getTitle() { return "My Tile"; },
    getIcon() { return "star"; },
  };
}
```

The SDK gives your tile access to katulong's platform:

| API | Description |
|-----|-------------|
| `sdk.sessions` | Create, list, kill terminal sessions |
| `sdk.pubsub` | Subscribe/publish to events |
| `sdk.terminal` | Spawn headless terminals, run commands |
| `sdk.storage` | Per-tile persistent key/value store |
| `sdk.tiles` | Create, remove, flip tiles in the carousel |
| `sdk.toast` | Show notifications |
| `sdk.api` | HTTP client for katulong's REST API |
| `sdk.ws` | Raw WebSocket send/receive |

See [docs/tile-sdk.md](docs/tile-sdk.md) for the full SDK reference and [docs/tile-system.md](docs/tile-system.md) for architecture details.

### Install community tiles

```bash
git clone https://github.com/someone/katulong-tile-foo ~/.katulong/tiles/foo
katulong restart
```

## Security

This application provides direct shell access to the host. Security isn't optional.

- **WebAuthn passkeys** — First device registers via passkey. Additional devices pair via QR code + PIN.
- **No passwords** — Identity is proven by cryptographic key, not a shared secret.
- **Localhost bypass** — Local connections auto-authenticate. Remote connections require a session cookie.
- **30-day sessions** — Server-side tokens, pruned on expiry. No tokens in URLs or localStorage.
- **Tile sandboxing** — Tiles run in the same origin as katulong (no iframe isolation). Only install tiles from trusted sources.

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
