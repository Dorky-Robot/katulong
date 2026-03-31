# Tile Dashboard — Flip View

The card carousel already supports front/back faces. Use the back face as a dashboard for managing the chaos of multiple agents and subprocesses.

## Open
- [ ] **Flip-to-dashboard** — tapping a "flip" gesture (or button) on a terminal tile rotates the card to show a dashboard face instead of the terminal. The terminal stays alive on the back, rendering continues — you just see the dashboard on the front.
- [ ] **What goes on the dashboard face?** — needs refinement. Candidates:
  - Task list / notes for that session (ties into the per-session notepad system)
  - Agent status: what the worker is doing, how long it's been running, last output summary
  - Crew overview: mini status cards for all workers in the same project/theme
  - Process tree: child processes running in the session (already tracked via `hasChildProcesses`)
  - Quick actions: kill, restart, view output, open terminal
- [ ] **Crew overview tile** — a special tile type (not a terminal) that shows all active crew workers at a glance. Each worker shows: name, status (working/done/idle), a 1-line summary of recent output. Tapping a worker promotes it to full terminal view.
- [ ] **Auto-flip on idle** — when a worker finishes (no child processes), auto-flip to dashboard showing the result summary. The user sees "done" without having to check each terminal.
- [ ] **Orchestrator tile** — a persistent tile that shows: all active themes, worker count per theme, recent events from pub/sub. This is the "mission control" view.

## Context
- Card carousel (`public/lib/card-carousel.js`) already has `card-inner` with front/back faces and a `.flipped` CSS class
- The tile system (`public/lib/tile-registry.js`) supports custom tile types — dashboard tiles already exist (`public/lib/tiles/dashboard-tile.js`)
- Per-session notes exist (`/api/notes/:session`) — could power the task list on the dashboard face
- Session status endpoint (`GET /sessions/:name/status`) provides alive/childCount data
- Pub/sub topics could carry agent events for the orchestrator tile
