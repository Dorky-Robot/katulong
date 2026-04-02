# Crew Dashboard

Live mini-tile view for orchestrated worker sessions. See `docs/dorkyrobot-stack.md` for the full design.

## Open
- [ ] **Crew tile type** — a new tile type (`crew-tile`) that renders a CSS grid of mini-terminals. Each cell is a real xterm.js instance subscribed to a `{project}--{role}` session's output, rendered at reduced font size. Tapping promotes to full terminal view.
- [ ] **Tile clusters by project** — group mini tiles by project name. The cluster acts as a single card in the carousel.
- [ ] **Background indicator** — sessions opened by API (not by user) get a subtle visual badge (robot icon already set via `req._apiKeyAuth`).
- [ ] **Auto-dismiss on done** — when a worker finishes (no child processes), mini tile fades or shows "done" state. Pub/sub exit event triggers this.
- [ ] **Flip-to-dashboard** — back face of terminal tiles shows: agent status, run duration, task assignment (from sipag), quick actions (kill, restart, logs), process tree.
- [ ] **Auto-flip on idle** — when worker finishes, auto-flip to dashboard showing result summary.
- [ ] **Orchestrator tile** — persistent tile showing all active projects, worker count per role, recent events from pub/sub. Mission control view.

## Context
- Card carousel already has front/back faces with `.flipped` CSS class
- Tile registry supports custom tile types — dashboard tiles exist (`public/lib/tiles/dashboard-tile.js`)
- Session status endpoint provides alive/childCount data
- Durable pub/sub (planned) will carry agent lifecycle events
- sipag (planned) will provide task assignment data
