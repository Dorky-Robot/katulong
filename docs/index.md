# Your Terminal, Everywhere

Self-hosted web terminal with passwordless authentication.
Access your shell from any device — desktop browser, phone, SSH — over LAN or internet.

*Katulong* (kah-too-LONG) means "helper" in Tagalog — your always-ready terminal assistant.

```bash
brew tap dorky-robot/katulong
brew install katulong
katulong start
```

[Get Started](getting-started.md){ .md-button .md-button--primary }
[View on GitHub](https://github.com/Dorky-Robot/katulong){ .md-button }

---

| | | |
|:---:|:---:|:---:|
| **Zero Passwords** | **WebAuthn** | **Self-Hosted** |
| Passwordless auth everywhere | Secure passkey authentication | Your machine, your data |

## How It Works

1. **Start katulong** — a single binary launches a daemon (PTY owner) and an HTTP/WebSocket server
2. **Open in browser** — an xterm.js frontend connects via WebSocket
3. **Register a passkey** — first visit registers your device with WebAuthn
4. **Access from anywhere** — use a tunnel (ngrok, Cloudflare) for remote access, or SSH directly

## Why Katulong

Traditional remote access tools force you to choose between convenience and security. SSH is secure but clunky on mobile. Web terminals are convenient but usually cloud-hosted. Katulong combines both:

- **Self-hosted** — runs on your machine, your data stays yours
- **Passwordless** — WebAuthn passkeys, no passwords ever
- **Multi-access** — browser, phone, SSH — whatever's handy
- **Single binary** — daemon + server + embedded frontend, nothing else to install
- **Session persistence** — the daemon survives server restarts; your sessions stay alive
- **Tunnel-friendly** — designed for ngrok, Cloudflare Tunnel, or any reverse proxy

## Architecture at a Glance

```
Browser (xterm.js) ──WebSocket──→ Server (HTTP/WS) ──Unix Socket──→ Daemon
                                  katulong serve      NDJSON         katulong daemon
                                  stateless                          PTY sessions
                                                                     ring buffers
```

The daemon owns all sessions. The server is stateless — restart it freely, your sessions survive. The browser reconnects and the daemon replays the output buffer. You pick up exactly where you left off.

## Quick Links

| Page | What You'll Learn |
|------|-------------------|
| [Getting Started](getting-started.md) | Install, first launch, register a passkey |
| [Features](features.md) | Everything katulong can do |
| [CLI Reference](cli-reference.md) | All commands and flags |
| [Security](security/index.md) | Auth model, hardening, threat surface |
| [Access Guide](access-guide/index.md) | Localhost, LAN, internet access setup |
| [Architecture](architecture.md) | Daemon/server split, WebSocket protocol |
| [Use Cases](use-cases.md) | Real-world scenarios |
