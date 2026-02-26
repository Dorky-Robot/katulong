# katulong

<div align="center">

<img src="katulong.png" alt="Katulong mascot" width="300">

</div>

A self-hosted web terminal that gives you shell access from any device over HTTP/HTTPS + WebSocket.

## Why "katulong"?

*Katulong* (kah-too-LONG) is Tagalog for *helper*.

Not assistant, not agent, not copilot — helper. The word carries a specific weight in Filipino culture: a katulong is someone who shows up, does the work alongside you, and makes the hard parts easier. They don't take over. They don't need to be managed. They're just there when you need them.

That's what this project is. You're already doing the work — building, deploying, debugging. Katulong just makes sure your terminal is there when you reach for it, whether you're at your desk, on the couch with your phone, or SSH'd in from across the house.

The name is a reminder of the intent: serve the person doing the work, don't get in their way.

## The problem

Your terminal is trapped on your laptop.

You start a long build. You go make coffee. You want to check if it's done from your phone — but you can't, because your terminal doesn't leave the machine it's running on.

You SSH into a server, start debugging, realize you need to context-switch to your desktop for the bigger screen. You open a new SSH session, re-navigate to the directory, try to remember where you were. The flow is broken.

Every solution involves tradeoffs: tmux requires SSH, which requires port forwarding, which requires a static IP or a VPN or a tunnel service. Cloud terminals require trusting a third party with shell access to your machine. Screen sharing works but it's slow and coarse.

The core issue: there's no simple way to access your shell sessions from wherever you happen to be, on whatever device you happen to have.

## The idea

Katulong takes a different approach. Your terminal sessions live in a daemon process on your machine. A web server sits in front of them, serving an xterm.js terminal over HTTP and WebSocket. Open a browser — any browser, any device — and you're connected.

```bash
katulong start
```

That's it. Your terminal is now available at `https://your-machine:3001` from any device on your network. Phone, tablet, another laptop — if it has a browser, it's a terminal.

```
Phone browser  ──WebSocket──┐
                             ├── UI Server (server.js) ──Unix Socket──  Daemon (daemon.js)
Desktop browser ──WebSocket──┘                                          PTY sessions
                                                                        Output buffers
SSH client ─────────────────────SSH server──────────────────────────────┘
```

The daemon owns the PTY sessions. The web server is stateless — restart it freely, your sessions survive. The browser reconnects and the daemon replays the output buffer. You pick up exactly where you left off.

Sessions are named. `/?s=deploy` connects to a session called "deploy". Open the same URL in two windows and you're sharing the session in real-time. Close all windows, come back tomorrow — the session is still there.

Prefer a raw terminal? SSH directly into any session. Same daemon, same PTYs, different transport.

### Security

This application provides direct terminal access to your machine. Security isn't optional.

First device registers via WebAuthn passkey. Subsequent devices pair via QR code + 6-digit PIN. Localhost bypasses auth. LAN and remote connections require a valid session cookie. Sessions are 30-day tokens, server-side, pruned on expiry.

No passwords to manage. No tokens in URLs. No `X-Forwarded-*` header trust. The only thing that proves identity is a cryptographic passkey or a physically-proximate pairing flow.

## Why not just SSH?

SSH is great. Katulong actually includes an SSH server. But SSH alone has friction that adds up:

- **You need a client.** Your phone doesn't have one. Your partner's laptop doesn't have one. A Chromebook at a coffee shop doesn't have one. A browser is universal.
- **You need keys or passwords.** SSH key management is a chore — generating keys, copying them to servers, rotating them, dealing with `Permission denied (publickey)`. Katulong uses WebAuthn passkeys. Register once with your fingerprint, done.
- **You need network plumbing.** SSH requires an open port, which means firewall rules, port forwarding, dynamic DNS, or a VPN. Katulong works over HTTPS through any tunnel — same port, same protocol as every other website.
- **Sessions require tmux.** SSH doesn't persist sessions on its own. You need tmux or screen, which means learning keybindings, configuring `.tmux.conf`, and remembering to attach. Katulong sessions persist by default. Close your browser, open it tomorrow, your session is there.
- **Mobile is painful.** Even with an SSH app, typing commands on a phone keyboard without Ctrl, Tab, or arrow keys is miserable. Katulong has swipe navigation, a shortcut toolbar, and a full-screen text area that works with speech-to-text.
- **Drag-and-drop doesn't work.** Try dragging an image into Claude Code over SSH — you get a file path dumped into the input, not the image. A browser terminal handles drag-and-drop, clipboard, and file uploads natively because it's a browser.
- **Sharing is hard.** Showing someone your terminal over SSH means giving them credentials and hoping they have a client. With Katulong, you share a URL. Multiple people can join the same session instantly — open the same link and you're pair programming in real time.

SSH is the right tool when you have a proper terminal, a configured client, and network access. Katulong is for everything else — the phone in your pocket, the tablet on the couch, the browser tab you can open anywhere.

## When SSH is the better choice

Katulong doesn't replace SSH — it fills a different gap. There are situations where SSH is clearly the right tool:

- **You're already at a terminal.** If you have iTerm, Alacritty, or any real terminal emulator open, SSH gives you native performance with zero overhead. No browser, no web server, no daemon — just a direct encrypted connection.
- **You need to transfer files.** `scp`, `rsync`, and SFTP are battle-tested. Katulong doesn't do file transfer — it's a terminal, not a file manager.
- **You're scripting or automating.** SSH is composable. `ssh host 'command'` in a script, piping output, running Ansible playbooks — the entire ops ecosystem is built on SSH as a primitive. Katulong is interactive-first.
- **You're accessing many machines.** SSH scales to hundreds of hosts with `~/.ssh/config`, jump hosts, and agent forwarding. Katulong runs on one machine and gives you a terminal to that machine.
- **You need port forwarding or tunneling.** SSH tunnels (`-L`, `-R`, `-D`) are a core feature. Katulong doesn't forward ports — it's focused on terminal access.
- **You want minimal attack surface.** SSH is a single well-audited binary with decades of hardening. Katulong is a Node.js web application with a broader surface area — HTTP server, WebSocket, browser frontend, and auth middleware. If you're hardening a production server, SSH with key-only auth and fail2ban is the simpler security story.
- **You want something that just works.** SSH is a single binary with no moving parts. Katulong has a daemon, a web server, and a browser frontend — more things that can clunk out, need restarting, or get into a weird state. SSH connects or it doesn't. There's no daemon to babysit.

The honest summary: if you have SSH access and a proper terminal, use SSH. Katulong is for when you don't — when you're on your phone, on a borrowed machine, or you want persistent sessions without tmux and shared access without credential management.

## Install

### Homebrew (macOS)

```bash
brew tap dorky-robot/katulong
brew install katulong

katulong start

# Or auto-start on login
brew services start katulong
```

### Manual

```bash
git clone https://github.com/dorky-robot/katulong.git
cd katulong
npm install
npm link  # Makes 'katulong' command available globally
```

## Updating

```bash
katulong update
```

Katulong detects how it was installed (Homebrew, npm global, or git clone) and runs the appropriate update. If the server is running, it performs a rolling restart — the new version starts up while the old one drains, so your terminal sessions are never interrupted.

```bash
katulong update --check       # Check if an update is available without applying it
katulong update --no-restart  # Update the code but skip the rolling restart
```

Sessions live in the daemon process, which is independent of the web server. During a rolling restart, the browser automatically reconnects to the new server and the daemon replays your scrollback. Typical downtime is 2-5 seconds.

## Quick start

```bash
katulong start        # Start the daemon + web server
katulong status       # Check if it's running
katulong open         # Open in your default browser
katulong logs         # View logs
katulong update       # Update to the latest version
katulong stop         # Stop everything
```

Visit `/` for the default session. Visit `/?s=myproject` for a named session. That's the whole interface.

For detailed CLI usage, run `katulong --help`.

## A walkthrough: your terminal follows you

You're at your desk. You start a deploy:

```bash
# Open a browser to your katulong instance
# Navigate to /?s=deploy
$ git push origin main && ./scripts/deploy.sh
```

The deploy is running. You grab your phone, walk to the kitchen, open `https://your-machine:3001/?s=deploy` in mobile Safari. The terminal is there — same session, same output, scrollback intact. The deploy finishes. You see it on your phone.

Back at your desk, you notice a bug in staging. You open `/?s=debug` on your desktop's bigger monitor. You start digging. Your laptop still has `/?s=deploy` open — two sessions, two devices, no conflict.

Later that night, you're on the couch. You SSH in from your iPad:

```bash
ssh -p 2222 debug@your-machine
# Password: your setup token
# You're in the "debug" session — same PTY, same scrollback
```

One daemon. Multiple transports. Your work follows you.

## Features

### Mobile-first terminal
- **Full-screen text input** — Dedicated textarea for commit messages, docs, or long-form text. Works with your phone's speech-to-text.
- **Swipe navigation** — Touch zone for arrow keys. Swipe to navigate without obscuring the terminal.
- **Smart keyboard handling** — Autocorrect and autocapitalize disabled. Virtual keyboard detection keeps the terminal in view.
- **PWA-ready** — Install as a full-screen app. No app store needed.

### Session management
- **Named sessions via URL** — `/?s=myproject` connects to a session called "myproject"
- **Sessions survive restarts** — Daemon owns PTYs. Restart the server, your sessions are still there.
- **Shared sessions** — Same URL in multiple windows = shared terminal
- **Session manager** — Create, rename, delete sessions from the UI

### Self-updating
- **One-command update** — `katulong update` detects install method and does the right thing
- **Rolling restart** — New server starts before old one exits. Sessions survive with ~2-5s reconnect.
- **Update check** — `katulong update --check` to see if a new version is available without applying it

### Power user features
- **Configurable shortcuts** — Pinned keys in the toolbar, full list in a popup
- **Cmd/Option key support** — Cmd+Backspace (kill line), Option+Backspace (delete word)
- **Touch-optimized toolbar** — Essential keys always accessible

### Screenshots

<div align="center">

<img src="docs/assets/images/terminal-main.png" alt="Main terminal interface" width="45%">
<img src="docs/assets/images/terminal-mobile.png" alt="Mobile terminal with touch controls" width="45%">

<img src="docs/assets/images/settings.png" alt="Settings panel" width="30%">
<img src="docs/assets/images/devices.png" alt="Device management" width="30%">
<img src="docs/assets/images/pairing-flow.png" alt="Secure device pairing" width="30%">

<img src="docs/assets/images/shortcuts-editor.png" alt="Shortcuts editor" width="60%">

</div>

## Architecture

```
Browser  <──WebSocket──>  UI Server (server.js)  <──Unix Socket──>  Daemon (daemon.js)
                          HTTP + static files                        PTY sessions
                          Auth middleware                             Output buffers
                          Device pairing                             Shortcuts I/O
```

- **`daemon.js`** — Long-lived process that owns PTY sessions. Communicates over a Unix domain socket via newline-delimited JSON.
- **`server.js`** — HTTP/HTTPS + WebSocket server. Routes, auth middleware, daemon IPC, device pairing.
- **`public/index.html`** — SPA frontend. xterm.js terminal, shortcut bar, settings, inline pairing wizard.
- **`lib/auth.js`** — WebAuthn registration/login, session token management, passkey storage.
- **`lib/tls.js`** — Auto-generated CA + server certificates for LAN HTTPS.
- **`lib/p2p.js`** — WebRTC DataChannel for low-latency terminal I/O.
- **`lib/ssh.js`** — SSH server bridging native terminals to daemon PTY sessions.

The daemon owns all PTY processes. The UI server is stateless — restart it freely without losing terminal sessions. On restart, the browser's reconnect logic kicks in and the daemon replays the output buffer.

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sessions` | List all sessions |
| POST | `/sessions` | Create a session `{ "name": "..." }` |
| PUT | `/sessions/:name` | Rename a session `{ "name": "..." }` |
| DELETE | `/sessions/:name` | Kill and remove a session |
| GET | `/shortcuts` | Get shortcut config |
| PUT | `/shortcuts` | Update shortcut config |

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | UI server port |
| `SHELL` | `/bin/zsh` | Shell to spawn in sessions |
| `KATULONG_SOCK` | `/tmp/katulong-daemon.sock` | Unix socket path for daemon IPC |

## Development

```bash
npm install           # Install dependencies
npm run dev           # Run daemon + server with auto-reload
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:e2e      # End-to-end tests (Playwright)
```

Open `http://localhost:3001` in a browser.

For production deployment, use the `katulong` CLI (see Install above).

## License

MIT
