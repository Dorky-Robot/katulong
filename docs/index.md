# Katulong

A self-hosted tile platform for getting work done from any device.

Katulong (kah-too-LONG, "helper" in Tagalog) turns your machine into a workspace you can access from any browser — desktop, phone, or tablet. Build tiles for any task: terminal access, project notes, dashboards, file management, or anything you need. The terminal tile gives you full shell access and pairs with tools like Claude Code for agentic workflows.

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
| **Tile Platform** | **WebAuthn** | **Self-Hosted** |
| Terminal, notes, dashboards — all tiles | Secure passkey authentication | Your machine, your data |

## How It Works

1. **Start katulong** — launches an HTTP/WebSocket server on your machine
2. **Open in browser** — a tile-based workspace loads in any browser
3. **Register a passkey** — first visit registers your device with WebAuthn
4. **Work from anywhere** — use a tunnel (Cloudflare, ngrok) for remote access

On tablets and phones, tiles appear as swipeable cards in a carousel. Each tile has optional chrome zones (toolbar, sidebar, shelf) for controls. Create multiple tiles, switch between them, and they persist across page reloads.

## Why Katulong

- **Tile platform** — terminal, notes, dashboards, and custom tiles in one workspace
- **Self-hosted** — runs on your machine, your data stays yours
- **Passwordless** — WebAuthn passkeys, no passwords ever
- **Multi-device** — browser, phone, tablet — whatever's handy
- **Extensible** — install community tiles or build your own with the Tile SDK
- **Agent-friendly** — terminal tile + pub/sub messaging enables agentic workflows
- **Session persistence** — terminal sessions backed by tmux; survive server restarts
- **Tunnel-friendly** — designed for Cloudflare Tunnel, ngrok, or any reverse proxy

## Architecture at a Glance

```
Browser                          Server (server.js)
├─ Tile Carousel (cards)         ├─ Tile Extensions (discovery, file serving)
│  ├─ Terminal tiles ──WS──────► ├─ Session Manager ── tmux sessions
│  ├─ Plano (notes) tiles        │                     PTY processes
│  ├─ Dashboard tiles            │                     ring buffers
│  └─ Extension tiles            ├─ Topic Broker (pub/sub event bus)
├─ Tile SDK (storage, ws, api)   ├─ Auth middleware (WebAuthn)
└─ Chrome zones (toolbar/sidebar)└─ Static files, file browser, port proxy
```

Tiles communicate through a topic-based pub/sub system. Terminal tiles subscribe to session topics for output. Any tile can emit events that other tiles react to — enabling orchestration between tiles, like Excel cells referencing each other.

## Part of the DorkyRobot Stack

Katulong is the workspace layer of the [DorkyRobot](https://dorkyrobot.com) ecosystem:

| Tool | Purpose |
|------|---------|
| **katulong** | Tile platform — the workspace where everything converges |
| **kubo** | Isolated sandboxes for agent execution |
| **tala** | Git-backed notes and context (API-first) |
| **sipag** | Prompt templates and project scaffolding |
| **tunnels** | Exposing services to the internet |
| **yelo** | Cloud-based persistence |
| **diwa** | Project insights and analytics |

## Quick Links

| Page | What You'll Learn |
|------|-------------------|
| [Getting Started](getting-started.md) | Install, first launch, register a passkey |
| [Features](features.md) | Everything katulong can do |
| [Tile System](tile-system.md) | How tiles work — carousel, chrome zones, lifecycle |
| [Tile SDK](tile-sdk.md) | Build your own tiles — SDK reference and examples |
| [CLI Reference](cli-reference.md) | All commands and flags |
| [Architecture](architecture.md) | Server architecture, API, WebSocket protocol |
| [Security](security/index.md) | Auth model, hardening, threat surface |
| [Use Cases](use-cases.md) | Real-world scenarios |
