# Features

Built for developers who need secure, anywhere access to their terminal.

## Passwordless Authentication

WebAuthn (passkeys) for secure, phishing-resistant authentication. Use your fingerprint, Face ID, or security key.

## Mobile-First Design

Beautiful, responsive interface optimized for mobile devices. Full terminal access from your phone or tablet.

- **Full-screen text input** — Dedicated textarea for commit messages, docs, or long-form text. Works with your phone's speech-to-text.
- **Swipe navigation** — Touch zone for arrow keys. Swipe to navigate without obscuring the terminal.
- **Smart keyboard handling** — Autocorrect and autocapitalize disabled. Virtual keyboard detection keeps the terminal in view.
- **PWA-ready** — Install as a full-screen app. No app store needed.

## Zero-Configuration P2P

Automatic WebRTC DataChannel for ultra-low latency. Falls back to WebSocket seamlessly.

## LAN Pairing

Scan a QR code + PIN to pair devices on your local network. No cloud services required.

## Customizable Shortcuts

Visual shortcut bar with custom commands. Keyboard shortcuts and dictation mode for faster workflows.

- Pinned keys in the toolbar, full list in a popup
- Cmd+Backspace (kill line), Option+Backspace (delete word)
- Touch-optimized toolbar with essential keys always accessible

## Security-First

Built with security at every layer: CSP headers, CSRF protection, atomic file operations, and comprehensive input validation.

## Multiple Access Methods

Web (HTTP/HTTPS), SSH, or remote tunneling (ngrok/Cloudflare). Choose what works for you.

## Multi-Session Support

Create, rename, and switch between multiple terminal sessions. Each session persists across reconnections.

- Named sessions via URL — `/?s=myproject` connects to a session called "myproject"
- Sessions survive restarts — Daemon owns PTYs. Restart the server, your sessions are still there.
- Shared sessions — Same URL in multiple windows = shared terminal

## Credential Management

Manage multiple devices with individual credentials. Revoke access instantly from any device.

## Self-Updating

One-command update with rolling restart:

```bash
katulong update             # Update to latest version
katulong update --check     # Check without applying
katulong update --no-restart  # Update code, skip restart
```

Sessions survive updates with ~2-5 second reconnect.
