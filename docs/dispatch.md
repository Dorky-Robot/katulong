# Dispatch: AI Work Queue & Orchestrator

Dispatch is a feature queue and orchestration system built into katulong's sidebar. It lets you capture feature ideas across all your projects, refine them with Claude, and dispatch autonomous agents to implement them in isolated kubo containers.

## Why

Katulong already manages terminal sessions. Kubo already sandboxes dangerous Claude work. Diwa already indexes project knowledge. Dispatch connects these pieces into a unified workflow: idea → refined spec → autonomous implementation.

The key insight: **use Claude's sub-agent capability within a single session** rather than spinning up many separate terminals. Sub-agents share context — if one changes an interface, the others can adapt. But separate kubos for separate projects, because katulong code has nothing to do with yelo code.

## Architecture

### Three-tier execution model

```
HOST (orchestrator)
│  Runs on macOS directly
│  Has: diwa, kubo CLI, katulong API, gh, brew
│  Does: refine ideas, plan work, spin up kubos, monitor progress
│
├─── kubo: agent-katulong
│    └─ yolo -p "implement these 3 tickets..."
│       ├─ sub-agent → worktree: keybindings
│       ├─ sub-agent → worktree: settings-ui
│       └─ sub-agent → worktree: tests
│
├─── kubo: agent-yelo
│    └─ yolo -p "implement these 2 tickets..."
│       ├─ sub-agent → worktree: dark-mode
│       └─ sub-agent → worktree: theme-toggle
│
└─── kubo: agent-diwa
     └─ yolo -p "add date range search..."
        └─ sub-agent → worktree: date-filter
```

### Why each layer runs where it does

| Layer | Runs where | Why |
|-------|-----------|-----|
| Orchestrator | Host macOS | Needs `kubo` CLI, `diwa`, katulong session API, host processes |
| Per-project worker | Kubo container | Sandboxed `--dangerously-skip-permissions`, isolated filesystem |
| Sub-agents | Inside kubo's Claude session | Shared context, parallel worktrees, Claude-native coordination |

### Grouping logic

Features targeting the **same project** run as sub-agents within a single kubo session. Features targeting **different projects** get separate kubos. This matches how work actually decomposes — related changes need shared context, unrelated changes need isolation.

## UI: Sidebar Pipeline

The dispatch panel lives in katulong's sidebar as a new section. It shows three stages:

### 1. Raw Ideas (input)

Free-text feature requests. You type quick thoughts without worrying about structure:
- "katulong should have vim keybindings"
- "yelo needs dark mode"
- "diwa search should support date ranges"

### 2. Refined Specs (review)

Claude processes raw ideas into actionable specs. For each idea it:
1. Identifies the target project from `diwa ls`
2. Runs `diwa search <project> "<idea>"` for related architectural history
3. Reads the project's `CLAUDE.md` for constraints
4. Produces: clear spec, sub-task breakdown, estimated agent count, risks from diwa history

Each refined spec shows:
- Target project name
- Clear description of what to build
- Sub-task breakdown with estimated worktree count
- Related diwa insights (past decisions, gotchas)
- Actions: **Start**, **Edit**, **Dismiss**

### 3. Active Work (execution)

Running work grouped by project/kubo. Each group shows:
- Kubo container name and status
- Per-sub-agent progress (which worktree, what phase: reading/building/testing)
- Live log stream via hooks

## Data Model

### Feature (stored in `.data/dispatch-features.json`)

```json
{
  "id": "f-1712044800000",
  "raw": "katulong should have vim keybindings",
  "status": "raw|refined|queued|active|done|failed|dismissed",
  "project": null,
  "refined": {
    "title": "Add configurable key bindings system",
    "spec": "...",
    "subtasks": [
      { "id": "st-1", "description": "Key bindings parser", "worktree": true },
      { "id": "st-2", "description": "Settings UI panel", "worktree": true },
      { "id": "st-3", "description": "Tests", "worktree": true }
    ],
    "diwaContext": ["insight-1", "insight-2"],
    "estimatedAgents": 3
  },
  "execution": {
    "kuboName": "agent-katulong-f1712044800000",
    "sessionName": "dispatch-katulong-a3f",
    "startedAt": "2026-04-02T...",
    "logs": [],
    "phase": "building|testing|merging|done"
  },
  "createdAt": "2026-04-02T...",
  "updatedAt": "2026-04-02T..."
}
```

### Project Registry (derived from `diwa ls` at runtime)

No need to duplicate — query diwa on demand.

## API Routes

All routes are authenticated (behind existing katulong auth middleware).

```
POST   /api/dispatch/features          — Add raw idea
GET    /api/dispatch/features          — List all features (all statuses)
PUT    /api/dispatch/features/:id      — Update feature (edit spec, change status)
DELETE /api/dispatch/features/:id      — Remove feature
POST   /api/dispatch/features/:id/refine   — Trigger refinement (raw → refined)
POST   /api/dispatch/features/:id/start    — Start execution (refined → active)
POST   /api/dispatch/features/:id/cancel   — Cancel active execution
GET    /api/dispatch/features/stream   — SSE stream for live progress
POST   /api/dispatch/hook              — Receives Claude tool-use hooks from kubos
GET    /api/dispatch/projects          — List available projects (from diwa ls)
```

## Execution Flow

### Refinement (triggered per-feature or in batch)

```
1. Parse raw idea text
2. Run `diwa ls` to get project list with paths
3. Ask Claude: "Which project does this target?" + project list
4. Run `diwa search <project> "<idea>"` for context
5. Read <project>/CLAUDE.md for constraints
6. Ask Claude to produce refined spec with subtask breakdown
7. Store refined spec, update status to "refined"
8. Notify sidebar via SSE
```

### Dispatch (triggered when user clicks Start)

```
1. Group all queued features by project
2. For each project group:
   a. Check if a kubo already exists for this project
      - Yes: reuse it (kubo add if needed)
      - No: `kubo new agent-{project}-{id} {project-path}`
   b. Create katulong session attached to the kubo
   c. Build prompt with:
      - All refined specs for this project
      - Diwa context
      - Project CLAUDE.md
      - Instructions: use sub-agents + worktrees, create PRs
   d. Execute in kubo: `yolo -p "<prompt>"`
   e. Wire up hooks for progress streaming
3. Update feature statuses to "active"
4. Stream progress to sidebar via SSE
```

### Progress Tracking (hooks)

Same pattern as Westley: configure `.claude/settings.local.json` inside the kubo to POST tool events to katulong's `/api/dispatch/hook` endpoint. The hook handler:
- Detects phase (reading/building/testing/committing)
- Extracts file names being edited
- Broadcasts to sidebar via SSE
- Persists logs to feature store

## Visible Sessions (v2 — next iteration)

Every dispatch action that runs Claude should create a **visible katulong terminal session**, not a hidden subprocess. The user controls their level of engagement:

### Two-layer feedback

1. **Sidebar bullets** — compact live status in the dispatch card (like Westley):
   - "Identifying project..."
   - "Searching diwa for context..."
   - "Generating spec..."
   - "Writing subtask breakdown..."
   - Quick glance without leaving what you're doing.

2. **"Open" button** — click to add the Claude session to the carousel as a terminal tile. Watch Claude think, scroll through its reasoning, type to redirect it. Same session, just surfaced into the UI.

### How it works

```
User clicks "Refine"
    ↓
Dispatch creates a katulong terminal session (e.g., "refine-f-abc123")
    ↓
Runs `claude -p "refine this idea..."` inside the session
    ↓
Sidebar card shows:
  ┌──────────────────────────────────┐
  │ @katulong make bg purple         │
  │ REFINING  just now        [Open] │
  │  · Identifying project...        │
  │  · Searching diwa for context... │
  └──────────────────────────────────┘
    ↓
User clicks [Open] → session appears in carousel as terminal tile
    ↓
User can watch, scroll back, or type into the Claude session
    ↓
When Claude finishes → parse output → update feature → status "refined"
```

### Same pattern for execution

When "Start" is clicked, dispatch creates a kubo container and a katulong session attached to it. The sidebar shows bullet updates from hooks. The "Open" button surfaces the kubo terminal in the carousel.

### Design principles

- **Sessions are the primitive.** Katulong already manages terminal sessions brilliantly. Dispatch should use them, not reinvent execution with hidden subprocesses.
- **Bullets for awareness, terminals for control.** Most of the time you glance at the sidebar. When something looks wrong or interesting, you open the session.
- **Sessions persist.** Even after refinement completes, the session stays so you can scroll back through Claude's reasoning. Delete it when you're done.

## Implementation Status

### Shipped (v1)
- Design doc (this file)
- Feature store with JSON persistence, async mutex locking
- API routes: CRUD, SSE, hooks, project listing
- Refinement engine (Claude + diwa) — currently uses hidden subprocess
- Dispatch executor (kubo + yolo) — currently uses hidden subprocess
- Left-side slide-out panel with FAB toggle
- @project mention autocomplete (Tab cycling, starts-with ranking)
- 55 tests covering store, routes, parsing, and autocomplete

### Next (v2 — visible sessions)
- Refine/execute via visible terminal sessions instead of hidden subprocesses
- Sidebar bullet updates (hook-driven, like Westley)
- "Open" button to surface session in carousel
- Session lifecycle management (create on action, persist for review, cleanup)

## Dogfooding Learnings

Building v1 with sub-agents taught us:
1. **Define interfaces first, then parallelize.** The store API and route contracts were locked before sub-agents ran — no coordination needed.
2. **Worktree isolation works.** 4 agents ran in parallel without conflicts.
3. **The linter can fight you.** File watchers on the main checkout caused branch switching when agents wrote files. Always use worktrees.
4. **SSE through tunnels is fragile.** Auth redirects kill EventSource silently. Fetch-after-action is more reliable for core state; SSE is for bonus real-time updates.
5. **Test the actual deployment.** Several bugs only showed up through the Cloudflare tunnel (CSRF, SSE, project loading). Staging early and often caught them.

## Prior Art

- **Westley feature request system**: Single-agent, immediate execution, kid→adult translation, SSE streaming, Claude tool hooks. Dispatch extends this with queuing, multi-project dispatch, kubo isolation, and sub-agent orchestration.
- **Katulong session management**: Already handles creating/listing/attaching terminal sessions. Dispatch builds on top of this.
- **Kubo containers**: Already provides isolated dev environments with `yolo` for dangerous Claude execution. Dispatch automates kubo lifecycle.
- **Diwa**: Already indexes project knowledge. Dispatch uses it for project discovery and context during refinement.
