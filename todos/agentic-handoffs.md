# Agentic Handoffs

Automated lifecycle management for orchestrated workers. See `docs/dorkyrobot-stack.md` for the full design.

## Open
- [ ] **Worker exit events via hooks → pub/sub** — use Claude Code's native `Stop` / `SubagentStop` hooks to publish to katulong's durable pub/sub (`crew/{project}/{role}/agent-done`). Replaces the previous plan to extend session-manager directly.
- [ ] **sipag subscribes to events** — sipag's TUI subscribes to crew topics via SSE, updates task board in real-time (move tasks to review/done).
- [ ] **Replace `crew wait` polling with SSE** — subscribe to exit topic instead of polling `GET /sessions/:name/status` every 2s. Depends on durable pub/sub.
- [ ] **Host-side Playwright agent** — a test-role session on the Mac host that subscribes to worker exit events, runs E2E tests with a real browser, and publishes results back to pub/sub.
- [ ] **Automated PR pipeline** — worker finishes → hook → pub/sub → host runs E2E → sipag creates PR → review agents → merge → release.

## Architecture
```
Claude Code (inside kubo)
  │ hook: SubagentStop / Stop
  ▼
katulong pub crew/{project}/{role}/agent-done
  │ durable pub/sub (file-backed, survives restarts)
  ▼
sipag sub crew/{project}/{role}/agent-done
  │ updates task board
  ▼
sipag TUI: ticket #42 → review
```

## Context
- Claude Code has 25+ hook events including SubagentStop, TaskCompleted, Stop
- Hooks can run shell commands, HTTP calls, or LLM prompts
- Durable pub/sub (planned) will survive katulong restarts
- sipag (planned) will own the cross-project task board and dispatch
