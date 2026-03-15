# Helm Mode — Claude Code Companion View

## Product Vision

Helm mode turns katulong into a **browser-based companion** for Claude Code terminal sessions. Instead of replacing the terminal TUI, helm provides a structured, readable view of the same conversation happening in the terminal — tool calls, prompts, responses — rendered as a chat-like UI in the browser.

The user runs Claude Code normally in the terminal (full TUI, interactive, using their Max subscription). Helm mode mirrors the session in the browser so they can:

- **Toggle** between terminal and helm views freely
- **Read** tool calls and results in a structured format (vs raw terminal output)
- **Type** in either view — helm input injects keystrokes into the terminal
- **Monitor** a Claude Code session from another device (e.g., phone via tunnel)

### Key Design Principles

1. **Companion, not replacement** — Claude Code runs in the terminal with full TUI. Helm is a read-along view.
2. **Hook-powered** — Uses Claude Code's native hook system for event streaming. No custom agent SDK or process wrapping.
3. **Max plan compatible** — No API billing. Claude Code uses the user's existing subscription.
4. **Session-scoped** — Hooks are written per-project (`.claude/settings.local.json`), so only intentional sessions stream to helm.
5. **Toggle-friendly** — A robot icon in the tab bar lets users switch views instantly.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Terminal (katulong web terminal / tmux)                     │
│  ┌────────────────────────────────┐                         │
│  │  claude --dangerously-skip-... │  ← full interactive TUI │
│  │  (Claude Code, Max plan)       │                         │
│  └────────────┬───────────────────┘                         │
│               │ hooks fire on events                        │
│               ▼                                             │
│  POST /api/helm/hook  (async, non-blocking)                 │
│               │                                             │
│  ┌────────────┴───────────────────┐                         │
│  │  Katulong Server               │                         │
│  │  bridge.relay() → broadcastAll │                         │
│  └────────────┬───────────────────┘                         │
│               │ WebSocket                                   │
│               ▼                                             │
│  ┌────────────────────────────────┐                         │
│  │  Browser (PWA)                 │                         │
│  │  ┌──────────┐ ┌─────────────┐ │                         │
│  │  │ Terminal  │ │ Helm View   │ │  ← toggle between views │
│  │  │ (xterm)   │ │ (chat UI)   │ │                         │
│  │  └──────────┘ └─────────────┘ │                         │
│  └────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

### Event Flow

1. **UserPromptSubmit** → User's prompt appears in helm as a user message
2. **PreToolUse** → Tool name + input rendered as a tool call card
3. **PostToolUse** → Tool result appended to the matching tool card
4. **Stop** → Assistant's final text rendered; turn marked complete
5. **Notification** → Permission prompts, idle alerts shown as system messages

### Input Flow (helm → terminal)

When the user types in the helm input area:
1. Browser sends `helm-input` WebSocket message with content
2. Server writes `content + \r` to the tmux session's PTY
3. Claude Code receives it as keyboard input (like typing in the terminal)

---

## Implementation

### Repos & Branches

| Repo | Branch | PR | Role |
|------|--------|-----|------|
| [Dorky-Robot/katulong](https://github.com/Dorky-Robot/katulong) | `feat/helm-mode` | [#352](https://github.com/Dorky-Robot/katulong/pull/352) | Server + browser UI |
| [Dorky-Robot/yolo](https://github.com/Dorky-Robot/yolo) | `feat/helm-mode` | [#1](https://github.com/Dorky-Robot/yolo/pull/1) | Claude Code launcher |

### Worktrees

```
/work/dorky_robot/katulong-helm-mode  → katulong feat/helm-mode
/work/dorky_robot/yolo-helm-mode      → yolo feat/helm-mode
```

### Key Files — Katulong

| File | Purpose |
|------|---------|
| `server.js` | Passes `bridge` to app routes for hook event relay |
| `lib/routes.js` | `/api/helm/hook` POST endpoint — receives Claude Code hook events, relays via bridge |
| `lib/ws-manager.js` | Broadcasts `helm-hook-event` to all browser clients; routes `helm-input` to terminal PTY |
| `lib/session-manager.js` | `getSession(name)` — returns session for direct PTY write |
| `lib/helm-session-manager.js` | Legacy WebSocket mode (yolo Agent SDK). Still wired up but unused in hook-based flow |
| `public/app.js` | `onHelmHookEvent()` — maps hook events to helm component; `getHelmToggleState()` — drives toggle button visibility |
| `public/lib/helm/helm-component.js` | Renders chat-like UI: user messages, tool calls with inputs/results, system info, status bar |
| `public/lib/shortcut-bar.js` | Robot icon toggle button (phone toolbar + desktop key island) |
| `public/lib/websocket-connection.js` | Routes `helm-hook-event` WebSocket messages to app.js |

### Key Files — Yolo

| File | Purpose |
|------|---------|
| `bin/yolo.js` | Detects katulong, writes `.claude/settings.local.json` with hooks, sends SessionStart, launches `claude --dangerously-skip-permissions` |
| `lib/detect.js` | Finds katulong via `~/.katulong/server.json` + health check, or `TERM_PROGRAM=katulong` + tmux |
| `lib/passthrough.js` | Execs `claude --dangerously-skip-permissions` (replaces process) |
| `lib/katulong-mode.js` | Legacy Agent SDK WebSocket mode — **not currently used**, kept for reference |

### Hook Configuration

Yolo writes this to `.claude/settings.local.json` in the working directory:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/api/helm/hook", "async": true }] }],
    "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/api/helm/hook", "async": true }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/api/helm/hook", "async": true }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/api/helm/hook", "async": true }] }],
    "Notification":     [{ "matcher": "", "hooks": [{ "type": "http", "url": "http://127.0.0.1:<port>/api/helm/hook", "async": true }] }]
  }
}
```

Port is read from `~/.katulong/server.json` at launch time.

---

## Current Status (2026-03-15)

### Working
- Hook endpoint receives and broadcasts events
- Helm view activates on first hook event
- Robot toggle button appears in tab bar
- Tool calls render with name, input, and results
- User prompts and assistant text display
- Helm input injects keystrokes into terminal (`\r` for Enter)
- Session-scoped hooks (only yolo-launched sessions stream)

### Known Issues / TODO
- **No streaming assistant text** — only get full text at `Stop` hook. Mid-generation text not visible in helm.
- **Helm input is raw PTY injection** — works but could be smarter (e.g., handle multi-line, escape sequences).
- **Legacy WebSocket mode** — `katulong-mode.js` and `helm-session-manager.js` still exist but are unused. Should be cleaned up or kept as alternative.
- **Session routing** — hook events broadcast to all browser clients. If multiple browser tabs are open, all see the events. Could filter by session.
- **Toggle button visibility** — button appears after first hook event but doesn't hide when session ends (helmHookSessionActive never resets).
- **No session end detection** — no hook fires when Claude Code exits. The helm view stays in "working" state.
- **Habiscript integration** — planned but not started. Habiscript v2.0.0 has widget protocol and dashboard layout that could replace the current raw HTML helm component.

### Future Vision
- **Habiscript-powered helm UI** — Use Habiscript's widget system to render helm as a dashboard with resizable panels for terminal, tool calls, file diffs, etc.
- **Multi-session support** — Multiple Claude Code sessions in different terminals, each with their own helm companion.
- **Rich tool rendering** — File diffs, image previews, code blocks with syntax highlighting instead of raw text.
- **Bidirectional control** — Approve/deny tool calls from the browser, not just text input.
- **Session persistence** — Save helm conversation history for review after session ends.
