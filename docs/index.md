# Your Terminal, Everywhere

Self-hosted web terminal with passwordless authentication.
Access your shell from any device — desktop browser, phone, or tablet — over LAN or internet.

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

1. **Start katulong** — launches an HTTP/WebSocket server that manages tmux sessions
2. **Open in browser** — an xterm.js frontend connects via WebSocket
3. **Register a passkey** — first visit registers your device with WebAuthn
4. **Access from anywhere** — use a tunnel (ngrok, Cloudflare) for remote access

## Why Katulong

Traditional remote access tools force you to choose between convenience and security. Web terminals are convenient but usually cloud-hosted. Katulong gives you both:

- **Self-hosted** — runs on your machine, your data stays yours
- **Passwordless** — WebAuthn passkeys, no passwords ever
- **Multi-access** — browser, phone, tablet — whatever's handy
- **Session persistence** — backed by tmux; sessions survive server restarts
- **Tunnel-friendly** — designed for ngrok, Cloudflare Tunnel, or any reverse proxy

## Architecture at a Glance

```
Browser (xterm.js) ──WebSocket──→ Server (server.js)
                                  Session manager ── tmux sessions
                                  Auth middleware     PTY processes
                                                     ring buffers
```

The session manager runs in-process. Sessions are backed by tmux — restart the server freely, your sessions survive. The browser reconnects and replays the output buffer. You pick up exactly where you left off.

## Quick Links

| Page | What You'll Learn |
|------|-------------------|
| [Getting Started](getting-started.md) | Install, first launch, register a passkey |
| [Features](features.md) | Everything katulong can do |
| [CLI Reference](cli-reference.md) | All commands and flags |
| [Security](security/index.md) | Auth model, hardening, threat surface |
| [Access Guide](access-guide/index.md) | Localhost, LAN, internet access setup |
| [Architecture](architecture.md) | Server architecture, WebSocket protocol |
| [Use Cases](use-cases.md) | Real-world scenarios |
