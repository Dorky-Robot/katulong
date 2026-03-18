# katulong

[![Discord](https://img.shields.io/discord/1483879594619568291?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://dorkyrobot.com/discord)

<div align="center">

<img src="katulong.png" alt="Katulong mascot" width="300">

*Katulong* (kah-too-LONG) — Tagalog for *helper*.

</div>

A remote desktop experience for your server, delivered through the browser. Terminal, file browser, port proxy, drag-and-drop — everything you need to work on a remote machine as if you were sitting in front of it.

## What it does

Katulong runs on your server and serves a native-feeling workspace over HTTP + WebSocket. Open a browser on any device — phone, tablet, laptop — and you get:

- **Terminal** — Full xterm.js shell with tmux-backed sessions that survive restarts and reconnects
- **File browser** — Browse, upload, download, and manage files on the remote host
- **Port proxy** — Access services running on the remote machine (dev servers, dashboards) through the browser
- **Drag and drop** — Drop files from your device into the terminal or file browser
- **Multi-session tabs** — Chrome-style tabs with drag reorder, tear-off to new window, and context menus
- **Clipboard bridge** — Copy/paste images and text between your device and the remote machine

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
katulong start        # Start the server
katulong open         # Open in your default browser
katulong status       # Check if it's running
katulong logs         # View logs
katulong update       # Update to the latest version
katulong stop         # Stop everything
```

Visit `/` for the default session. Visit `/?s=myproject` for a named session.

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
                              ├── File browser
                              ├── Port proxy
                              └── Auth (WebAuthn)
```

Sessions live in tmux on the host. Restart the server, your sessions survive. The browser reconnects and replays the output buffer. Close your laptop, open your phone — same session, same scrollback.

### Touch-first design

Built for iPad and mobile from day one:

- Dedicated text input area (works with dictation/speech-to-text)
- Swipe arrow keys, pinned Esc/Tab buttons
- Floating shortcut island, draggable and auto-clamped to viewport
- PWA-ready — install as a full-screen app

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
| `KATULONG_DATA_DIR` | `~/.katulong` | Auth state and config |

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
