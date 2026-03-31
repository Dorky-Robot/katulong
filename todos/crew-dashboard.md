# Crew Dashboard

Mini-tile view for orchestrated worker sessions.

## Open
- [ ] **Mini tiles** — when the orchestrator spawns workers, show them as small preview tiles (like the mockup) instead of full tabs. Each mini tile shows a live terminal preview at reduced scale. Tapping a mini tile promotes it to the main view.
- [ ] **Tile clusters** — group related mini tiles together (by crew project name). The cluster acts as a single card in the carousel. Swiping cycles through clusters, tapping a tile within a cluster zooms in.
- [ ] **Background indicator** — worker sessions opened by the API (not by the user) should have a subtle visual distinction in the session list (icon, badge, or color) so you know "I didn't open this, something else did"
- [ ] **Auto-dismiss** — when a worker finishes (shell exits or `yolo` completes), the mini tile could fade or show a "done" state instead of staying active

## Context
- Katulong already has a dashboard tile system (`public/lib/tiles/dashboard-tile.js`) that renders a CSS grid of sub-tiles
- The carousel (`public/lib/card-carousel.js`) supports multiple tile types
- The `set-tab-icon` WebSocket message can set per-session icons
- Worker sessions use `{theme}--{worker}` naming convention
