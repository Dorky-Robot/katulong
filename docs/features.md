# Features

## Tile Platform

Katulong's core is a tile system — composable, extensible UI surfaces that can hold any functionality. On tablets, tiles appear as swipeable cards in a carousel. On desktop, they work as tabs.

- **Terminal tile** — full xterm.js terminal with tmux session persistence
- **Extension tiles** — install from `~/.katulong/tiles/` or a marketplace
- **Chrome zones** — each tile has optional toolbar, sidebar, and shelf areas
- **Tile SDK** — storage, platform info, WebSocket, pub/sub, toast notifications
- **Serialize/restore** — tiles persist across page reloads via sessionStorage

## Tile Extension System

Third-party tiles live in `~/.katulong/tiles/<name>/` with a `manifest.json` and `tile.js`. Katulong discovers them at startup and makes them available in the `+` menu.

- **Discovery** — server scans `~/.katulong/tiles/` for valid extensions
- **Dynamic loading** — client imports tile modules before carousel restore
- **Namespaced SDK** — each extension gets isolated storage and platform APIs
- **File serving** — extension assets served at `/tiles/<name>/` with path traversal protection

See [Tile SDK](tile-sdk.md) for the full developer reference.

## Terminal

Full terminal emulator in the browser powered by xterm.js with WebGL rendering. The terminal is a tile — it follows the same lifecycle as any other tile, but connects to tmux sessions via WebSocket.

- GPU-accelerated rendering via WebGL addon
- Terminal pool pre-allocates xterm instances for instant session switching
- Topic-based pull system for terminal output (each session is a pub/sub topic)
- Output buffer replay on reconnect — pick up exactly where you left off

## Multi-Session Management

Create, rename, switch, and destroy terminal sessions. Each session is a tmux session that persists across server restarts and reconnections.

- Named sessions via URL — `/?s=myproject`
- Create sessions with `POST /sessions` or from the UI
- Rename sessions without losing state
- Sessions survive server restarts — tmux owns the PTY

## Pub/Sub Event System

Topic-based messaging between tiles and between client and server. Terminal sessions are topics, but any tile can publish or subscribe to events.

- **CLI integration** — `katulong pub <topic> <message>`, `katulong sub <topic>`
- **WebSocket transport** — tiles subscribe via `sdk.ws.on()` or `sdk.pubsub`
- **Tile orchestration** — tiles react to each other's events (like Excel cells with formulas)
- **Server-side topic broker** — manages subscriptions and message delivery

## Mobile-First Design

Responsive interface optimized for phones and tablets.

- **Carousel mode** — swipeable tile cards on iPad and mobile
- **Virtual keyboard handling** — autocorrect disabled, keyboard detection keeps content in view
- **Shortcut bar** — touch-optimized toolbar with essential keys (Tab, Ctrl, Esc, arrows)
- **Full-screen text input** — dedicated textarea for commit messages and long-form text
- **Dictation mode** — works with your phone's speech-to-text
- **Swipe navigation** — joystick touch zone for arrow keys
- **PWA support** — install as a full-screen app, no app store needed

## File Browser

Navigate, upload, download, and manage files on the host.

- Browse directories with a visual file listing
- Upload files via the file browser or drag-and-drop
- Download files from the host to your device
- Create directories, rename files, delete files

## Remote Clipboard Bridge

Paste text and images across machines (e.g., iPad to Mac mini via tunnel).

Three-layer interception handles browser clipboard restrictions:

1. Block xterm's keydown handler for Ctrl+V/Cmd+V
2. Handle the paste event with Clipboard API
3. WebKit fallback for browsers that suppress paste after preventDefault

See [Clipboard Bridge](clipboard-bridge.md) for the full architecture.

## Port Proxy

Access localhost services running on the host from your browser, even when connecting via tunnel.

- Proxies WebSocket upgrade requests to local ports
- Useful for accessing dev servers, databases, or dashboards running on the host

## P2P Progressive Enhancement

Automatic WebRTC DataChannel upgrade for low-latency terminal I/O when the client is on the same LAN as the host.

- Baseline: connect via tunnel (WebSocket over HTTPS)
- Enhancement: when on the same LAN, upgrade to WebRTC DataChannel
- Falls back to WebSocket seamlessly on failure
- Connection indicator shows direct (green) vs relay (orange) status

See [P2P Progressive Enhancement](p2p-progressive-enhancement.md) for technical details.

## Passwordless Authentication

WebAuthn (passkeys) for secure, phishing-resistant authentication.

- First device registers via passkey (fingerprint, Face ID, security key)
- Additional devices register via setup token + passkey
- Localhost requests bypass auth automatically
- 30-day session tokens with automatic pruning

## Self-Updating

One-command update with rolling restart:

```bash
katulong update             # Update to latest version
katulong update --check     # Check without applying
```

Sessions survive updates with ~2-5 second reconnect.

## Customizable Shortcuts

Visual shortcut bar with custom commands.

- Pinned keys in the toolbar, full list in a popup
- Cmd+Backspace (kill line), Option+Backspace (delete word)
- Edit shortcuts via settings UI or API

## Instance Customization

Personalize your katulong instance.

- Custom instance name, icon, and toolbar color
- All settings persisted via config API
