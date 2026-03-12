# Features

Complete inventory of everything katulong can do.

## Web Terminal

Full terminal emulator in the browser powered by xterm.js with WebGL rendering. Connects to tmux sessions via WebSocket for real-time I/O.

- GPU-accelerated rendering via WebGL addon
- Terminal pool pre-allocates xterm instances for instant session switching
- Output buffer replay on reconnect — pick up exactly where you left off
- Coalesced output dispatch reduces partial-frame rendering in TUI apps

## Multi-Session Management

Create, rename, switch, and destroy terminal sessions. Each session is a tmux session that persists across server restarts and reconnections.

- Named sessions via URL — `/?s=myproject` connects to a session called "myproject"
- Create sessions with `POST /sessions` or from the UI
- Rename sessions without losing state
- Sessions survive server restarts — tmux owns the PTY

## Tab Management

Multi-window support with tear-off tabs. Each tab connects to a different session.

- Open multiple sessions as tabs in a single browser window
- Tear off a tab into its own window
- Tab bar shows all active sessions with quick switching
- URL reflects current session for bookmarking

## Tmux Session Browser

Discover and adopt existing tmux sessions not created by katulong.

- `GET /tmux-sessions` lists unmanaged tmux sessions
- `POST /tmux-sessions/adopt` brings an external session under katulong management
- Useful for attaching to sessions started via SSH or local terminal

## Mobile-First Design

Responsive interface optimized for phones and tablets.

- **Virtual keyboard handling** — autocorrect and autocapitalize disabled, keyboard detection keeps terminal in view
- **Shortcut bar** — touch-optimized toolbar with essential keys (Tab, Ctrl, Esc, arrows) always accessible
- **Full-screen text input** — dedicated textarea for commit messages, docs, or long-form text
- **Dictation mode** — works with your phone's speech-to-text
- **Swipe navigation** — joystick touch zone for arrow keys without obscuring the terminal
- **PWA support** — install as a full-screen app, no app store needed
- **Split phone/tablet layout** — different toolbar layouts for different device sizes

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

Image paste uploads the image to the host and copies it to the macOS clipboard. See [Clipboard Bridge](clipboard-bridge.md) for the full architecture.

## Drag-and-Drop Upload

Drop files or images directly onto the terminal to upload them to the host. Images are copied to the macOS clipboard for pasting into other apps.

## Port Proxy

Access localhost services running on the host from your browser, even when connecting via tunnel.

- Enable via `PUT /api/config/port-proxy-enabled`
- Proxies WebSocket upgrade requests to local ports
- Useful for accessing dev servers, databases, or dashboards running on the host

## P2P Progressive Enhancement

Automatic WebRTC DataChannel upgrade for low-latency terminal I/O when the client is on the same LAN as the host.

- Baseline: connect via tunnel (WebSocket over HTTPS)
- Enhancement: when on the same LAN, upgrade to WebRTC DataChannel
- Near-zero latency even though you connected via internet
- Falls back to WebSocket seamlessly on failure
- No STUN/TURN servers needed (LAN-only)
- Connection indicator shows direct (green) vs relay (orange) status

See [P2P Progressive Enhancement](p2p-progressive-enhancement.md) for technical details.

## Passwordless Authentication

WebAuthn (passkeys) for secure, phishing-resistant authentication.

- First device registers via passkey (fingerprint, Face ID, security key)
- Additional devices register via setup token + passkey
- Localhost requests bypass auth automatically
- 30-day session tokens with automatic pruning

## Credential and Device Management

Manage registered devices and access tokens.

- `GET /api/credentials` lists all registered passkeys with metadata
- Revoke individual credentials from any device
- Setup tokens for pairing new devices (7-day TTL)
- Token management via CLI or API

## Self-Updating

One-command update with rolling restart:

```bash
katulong update             # Update to latest version
katulong update --check     # Check without applying
katulong update --no-restart  # Update code, skip restart
```

Sessions survive updates with ~2-5 second reconnect. The server drains gracefully — clients receive a `server-draining` message and fast-reconnect to the new instance.

## Customizable Shortcuts

Visual shortcut bar with custom commands.

- Pinned keys in the toolbar, full list in a popup
- Cmd+Backspace (kill line), Option+Backspace (delete word)
- Edit shortcuts via `GET /shortcuts` and `PUT /shortcuts`

## Instance Customization

Personalize your katulong instance.

- Custom instance name (shown in title bar and tabs)
- Custom instance icon
- Custom toolbar color
- All settings persisted via `PUT /api/config/*`

## Service Worker Caching

Offline-capable with service worker caching of static assets. Cache-busted on server updates.

## Three-Access-Method Detection

Katulong automatically detects how you're connecting:

- **Localhost** — direct access on the host machine, auth bypassed
- **LAN** — access from another device on the local network
- **Internet** — access via tunnel (ngrok, Cloudflare Tunnel, etc.)

The access method determines auth requirements and available features (e.g., P2P is only available on LAN).
