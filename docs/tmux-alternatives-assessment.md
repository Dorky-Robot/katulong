# Terminal Multiplexer Alternatives Assessment

**Date:** April 2026
**Status:** tmux remains the best fit. Reassess if new tools emerge with structured control protocols.

## Why tmux?

Katulong uses tmux's **control mode** (`-u -C attach-session`) as its terminal I/O transport layer. This provides:

- **Persistent named sessions** — shells survive katulong crashes/restarts
- **Structured stdio protocol** — `%output` lines with octal-escaped payloads, `%begin`/`%end` command responses
- **In-band commands** — resize (`refresh-client -C`), input (`send-keys -H`), and queries through the same pipe
- **Screen capture** — `capture-pane -e` for seeding new clients on reconnect
- **State queries** — cursor position, CWD, pane PID via `display-message`
- **Environment isolation** — `set-environment` to filter sensitive vars from PTY processes

We use zero window/pane/layout features. The value is entirely in the control mode protocol and session persistence.

## Alternatives evaluated

### Full multiplexers

| Tool | Control protocol? | Session persistence? | Verdict |
|------|-------------------|---------------------|---------|
| **Zellij** (Rust) | No. Plugin system is Wasm-based, not a stdio protocol. | Yes | No programmatic I/O path. |
| **GNU Screen** | No structured protocol. `-x` multiattach exists but output is raw terminal escapes. | Yes | Would require scraping raw output. |
| **Byobu** | Wrapper on tmux/screen — same backend. | Yes (via tmux) | No additional capability. |

### Terminal emulators with multiplexing

| Tool | Control protocol? | Session persistence? | Verdict |
|------|-------------------|---------------------|---------|
| **WezTerm** (Rust) | Lua scripting API, but designed for local desktop use. | No (emulator, not server) | Not a server-side session manager. |
| **Kitty** (C/Python) | Remote control protocol exists but designed for local terminal emulator control. | No | Same — not for headless server use. |

### Minimal attach/detach tools

| Tool | What it does | Verdict |
|------|-------------|---------|
| **abduco** | Attach/detach a single process. No multiplexing, no protocol. | Too minimal. |
| **dtach** | Same as abduco, even simpler. | Too minimal. |
| **dvtm** | Tiling multiplexer (pairs with abduco). TUI app, no programmatic API. | Not programmable. |

### Other tools

| Tool | What it does | Verdict |
|------|-------------|---------|
| **Eternal Terminal (et)** | Reconnectable SSH replacement. Not a multiplexer. | Solves a different problem. |
| **libvterm** | C library that parses VT escapes into structured callbacks. Used by NeoVim. | Interesting as a complement (could replace headless xterm.js), but not a session manager. |
| **node-pty** | Node.js PTY bindings. Direct spawn/read/write. | Could replace tmux but loses session persistence across crashes. |

## Handroll option

A custom solution using **node-pty + a supervisor daemon** could replicate tmux's role. This would mean:

- PTY spawning via `node-pty` or raw `openpty`
- Session persistence via a separate daemon process (essentially building a tmux server)
- Screen state from the existing headless xterm.js (fed directly from PTY instead of `%output` parsing)
- Resize via `TIOCSWINSZ` ioctl

**Tradeoff:** Significant implementation effort to drop a well-understood, stable dependency. The main gain would be eliminating tmux quirks (3.6a UAF bug, yacc parser arg limits, octal escaping). The main loss is that a katulong crash would kill all sessions unless a separate daemon is built for persistence.

## Conclusion

tmux's control mode is unique in the ecosystem. No other tool provides a structured, parseable stdio protocol for programmatic terminal session management with persistence. The quirks we've worked around (UAF bug, send-keys chunking, octal unescaping) are minor compared to the cost of replacing or reimplementing the control mode protocol.

**Reassess when:** A new multiplexer ships with a first-class programmatic control API, or if tmux control mode introduces breaking changes.
