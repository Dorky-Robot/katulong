# Dispatch v2: Visible Sessions

Replace hidden subprocess execution with visible katulong terminal sessions.

## Why

Currently "Refine" runs `claude --print -p` as a hidden subprocess — no visibility, no control. The user wants to see Claude thinking and interact with it if needed. Katulong already manages terminal sessions; dispatch should use that capability.

## Tasks

### 1. Sidebar bullet updates
- [ ] When refine/execute starts, show live status bullets in the dispatch card
- [ ] Bullet stream: "Identifying project...", "Searching diwa...", "Generating spec..."
- [ ] Use Claude Code hooks (PostToolUse → POST /api/dispatch/hook) for execution phase
- [ ] For refinement, emit progress events at each step (project ID, diwa search, spec gen)

### 2. Visible refine sessions
- [ ] Refine creates a katulong terminal session (`refine-<feature-id>`)
- [ ] Runs `claude -p "refine this..."` inside the session (not --print, actual interactive)
- [ ] Parse Claude's output when it finishes to extract the spec
- [ ] Update feature status + refined spec from parsed output
- [ ] Session persists after completion for review

### 3. "Open" button on dispatch cards
- [ ] Add "Open" button to cards in refining/active state
- [ ] Click creates a terminal tile in the carousel attached to the dispatch session
- [ ] If tile already exists, focus it instead of duplicating
- [ ] Terminal tile shows the live Claude session — user can watch and type

### 4. Visible execute sessions
- [ ] Execute creates a kubo container + katulong session attached to it
- [ ] Runs `yolo -p "implement..."` inside the kubo session
- [ ] Session appears in carousel via "Open" button
- [ ] Hooks stream bullet updates to sidebar

### 5. Session lifecycle
- [ ] Sessions named deterministically: `dispatch-refine-<id>`, `dispatch-exec-<id>`
- [ ] Store session name in feature.execution for reconnection
- [ ] "Open" works even after page reload (reconnects to existing session)
- [ ] Completed sessions stay until explicitly dismissed or feature deleted

## Key files
- `lib/dispatch-refine.js` — currently uses `execFile(claude)`, needs to use session manager
- `lib/dispatch-executor.js` — currently uses `spawn(docker exec yolo)`, needs kubo + session
- `public/lib/dispatch-panel.js` — needs bullet rendering and "Open" button
- `lib/session-manager.js` — createSession API for programmatic session creation
- `public/lib/card-carousel.js` — for adding terminal tiles
- `docs/dispatch.md` — design doc (updated with v2 section)

## Reference
- Westley's hook system: `.claude/settings.local.json` PostToolUse → HTTP endpoint
- Katulong session creation: `POST /sessions` → session-manager.createSession()
- Carousel tile creation: `createTile('terminal', { session })` → card-carousel.activate()
