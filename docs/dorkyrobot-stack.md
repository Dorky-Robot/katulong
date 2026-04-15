# Dorky Robot Stack — Architecture & Design

How katulong, sipag, hulma, tunnels, kubo, diwa, and yolo work together as an autonomous software consultancy toolkit.

## Philosophy

Three rewrites of sipag's orchestrator converged on one lesson: **let the LLM decide, keep the tool mechanical.** Every time we tried to make semantic decisions in tooling (issue clustering, retry logic, planning), the LLM did it better. Our tools handle infrastructure — sessions, containers, state files, event delivery — and push all judgment to Claude Code.

The second lesson: **don't reinvent what Claude Code has.** Subagents, skills, hooks, memory, worktree isolation, and agent teams are built-in. We build the layers Claude Code doesn't have: cross-machine orchestration, durable event delivery, web UI, and multi-project task management.

## The Stack

```
┌──────────────────────────────────────────────────────────────┐
│                        User (iPad / browser)                 │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS (via tunnels)
┌────────────────────────────▼─────────────────────────────────┐
│  katulong — data plane                                       │
│  Web terminals, durable pub/sub, terminal clusters           │
│  Node.js · host machine · ~/.katulong/                       │
└────┬──────────┬──────────┬──────────┬────────────────────────┘
     │          │          │          │
     │   ┌──────▼──────┐   │   ┌──────▼──────┐
     │   │ kubo A      │   │   │ kubo B      │
     │   │ (katulong)  │   │   │ (sipag)     │
     │   │ Rust env    │   │   │ Rust env    │
     │   │ yolo, claude│   │   │ yolo, claude│
     │   └─────────────┘   │   └─────────────┘
     │                     │
┌────▼─────────────┐  ┌────▼─────────────┐
│ sipag             │  │ diwa             │
│ refine + board    │  │ knowledge plane  │
│ + dispatch        │  │ Git history      │
│ Rust TUI + CLI    │  │ search (Rust)    │
└──────────────────┘  └──────────────────┘
        ▲
        │ scaffolds .claude/
┌───────┴──────────┐
│ hulma            │
│ scaffolder       │
│ Rust CLI         │
└──────────────────┘
```

| Tool | Language | Role | Runs On |
|------|----------|------|---------|
| **katulong** | Node.js | Web terminals, durable pub/sub, terminal clusters | Host (Mac) |
| **sipag** | Rust | Feature refinement, task board, dispatch to katulong | Host or kubo |
| **hulma** | Rust | Project-aware Claude Code scaffolder (`.claude/` setup) | Host |
| **tunnels** | Rust | k9s-style TUI for managing cloudflared tunnel instances | Host (Mac) |
| **kubo** | Rust | Isolated dev environments in Docker (Colima-backed) | Host (Mac) |
| **diwa** | Rust | Git history search — institutional memory | Host or kubo |
| **yolo** | Node.js | Claude Code launcher for kubos | Inside kubos |

### katulong — data plane

What it owns:
- **Web terminal sessions** via tmux (survive server restarts)
- **Durable pub/sub** — file-backed event bus in `~/.katulong/pubsub/` (survives restarts/updates)
- **Live mini-tiles** — scaled-down terminal views of running agents
- **Cross-machine bridge** — kubos and host connect via public URL + API key
- **Crew sessions** — `{project}--{role}` naming, lifecycle management
- **WebAuthn auth** — passkeys, no passwords
- **Notifications** — browser push + toast fallback

What it doesn't own:
- Task tracking (that's sipag)
- Semantic decisions about what to work on (that's the LLM)
- Container lifecycle (that's kubo)

### sipag — control plane

What it owns:
- **Multi-project task board** — kanban, filterable by project/role/status
- **Role templates** — defines what dev/test/perf/product sessions look like per project
- **Feature refinement** — `sipag feature add` captures raw ideas, `sipag refine` spawns Claude to turn them into actionable ticket bullets
- **Dispatch** — translates "work on ticket #12" into the right session, worktree, and yolo invocation against katulong
- **Cross-project visibility** — one TUI showing all projects, all roles, all tasks

What it doesn't own:
- Terminal sessions (that's katulong)
- Container management (that's kubo)
- Git history search (that's diwa)
- Project scaffolding — `.claude/agents/`, slash commands, hooks (that's **hulma**, extracted from sipag in April 2026)

### kubo — sandbox

What it owns:
- **Dev containers** — full stack (Claude Code, Node, Rust, Go, gh, tmux)
- **Isolation** — each project gets its own container, host network shared
- **Persistence** — home dir and work dir survive container updates
- **Mount management** — `~/.katulong/`, `~/.diwa/`, `~/.sipag/` shared with host

### hulma — scaffolder

What it owns:
- **Project scaffolding** — `hulma configure` writes `.claude/agents/`, `.claude/commands/`, and git hooks into a project
- **Two paths** — generative (spawns `claude` to read the repo and pick the right templates) or `--static` (ships reference templates verbatim)
- **Single static binary** — every template is embedded via `include_str!`; no runtime template directory
- **Templates** — review agents, slash commands (`/commit`, `/review-pr`, etc.), pre-commit and pre-push hooks, katulong pub/sub bridges

What it doesn't own:
- Anything at runtime — once `hulma configure` is done, hulma is out of the loop. The boundary: **hulma writes files, sipag runs work**.

### tunnels — connectivity

What it owns:
- **cloudflared tunnel lifecycle** — install, route, list, remove via a k9s-style TUI and a `tunnels` CLI
- **LaunchAgent management** — daemonizes tunnels under launchd so they survive reboots
- **Route mapping** — `tunnels route add <hostname> <port> --tunnel <name>`

### diwa — knowledge plane

What it owns:
- **Git history indexing** — commits, decisions, patterns across all projects
- **Cross-project search** — `diwa search <project> "<query>"`
- **Institutional memory** — what was tried, what failed, what worked

### yolo — launcher

What it owns:
- **Claude Code entry point** inside kubos — wraps `claude --dangerously-skip-permissions`
- **Future: helm mode** — detect katulong session, stream structured events to web UI (deferred)

What it doesn't own:
- Event streaming (use Claude Code hooks → katulong pub/sub instead)
- Agent configuration (that's sipag's role templates)

## Session Model

### Sessions are scoped by project + role

Claude encourages running multiple agents in the same session because they share memory context (CLAUDE.md, auto memory, project conventions). Different projects should be in different sessions to avoid context contamination.

We add a second dimension: **role**. Each role has different context needs:

```
Project: katulong
  ├── katulong--dev        → code changes, bug fixes, features
  ├── katulong--test       → QA, E2E, regression, smoke tests
  ├── katulong--perf       → latency audits, profiling, benchmarks
  └── katulong--product    → backlog grooming, specs, triage

Project: kubo
  ├── kubo--dev            → container tooling, networking fixes
  └── kubo--test           → integration tests
```

Within each role-session, **multiple agents work different tickets** sharing that role's accumulated context. A new agent in `katulong--dev` doesn't start cold — the session already understands katulong's codebase from previous agents.

**Cross-project context**: use `diwa search <project> "<query>"` instead of mixing session contexts.

**Cross-role context**: same — diwa or explicit handoff. Don't merge dev and test contexts.

### Naming convention

`{project}--{role}` (double-dash separator)
- Safe in tmux
- Parseable: `name.split("--")` on first occurrence
- Examples: `katulong--dev`, `kubo--test`, `sipag--product`

## Integration: Hooks → Pub/Sub → Board

Claude Code has 25+ lifecycle hook events. Instead of building custom event systems, we wire hooks to katulong's durable pub/sub, which sipag subscribes to:

```
Claude Code (inside kubo)
  │
  │ hook: SubagentStop
  ▼
katulong pub crew/{project}/{role}/agent-done
  │
  │ durable pub/sub (file-backed)
  ▼
sipag sub crew/{project}/{role}/agent-done
  │
  │ updates task board
  ▼
sipag TUI: ticket #12 → done
```

### Hook configuration (per project)

```yaml
# .claude/settings.json or sipag-generated hooks
hooks:
  SubagentStop:
    - command: "katulong pub crew/$PROJECT/$ROLE/agent-done '{\"task\":\"$TASK_ID\"}'"
  TaskCompleted:
    - command: "sipag move $TASK_ID review"
  Stop:
    - command: "katulong pub crew/$PROJECT/$ROLE/session-idle"
```

### Key events

| Claude Code Event | Pub/Sub Topic | sipag Action |
|-------------------|---------------|--------------|
| SubagentStart | `crew/{project}/{role}/agent-start` | Mark task in-progress |
| SubagentStop | `crew/{project}/{role}/agent-done` | Mark task review |
| TaskCompleted | (direct CLI call) | Move task on board |
| Stop | `crew/{project}/{role}/session-idle` | Show idle in TUI |
| Session exit | poll `GET /sessions/{name}/status` | Mark role-session offline |

## sipag — Design

### Data model

```
~/.sipag/
  config.toml              # default org, views, katulong URL
  projects/
    katulong/
      project.toml         # repo, host katulong URL, custom statuses
      roles/
        dev.toml           # session template for dev role
        test.toml
        perf.toml
        product.toml
      tasks/
        001.toml           # individual task files
        002.toml
    kubo/
      project.toml
      roles/
        dev.toml
      tasks/
        001.toml
```

### Role templates

```toml
# ~/.sipag/projects/katulong/roles/dev.toml
name = "dev"
type = "kubo"                    # "kubo", "host", "local"
container = "katulong"           # kubo container name
worktree = true                  # auto-create git worktree per task
command = "yolo"                 # agent entry point (NOT --dangerously...)
memory_context = "shared"        # agents share project memory
```

```toml
# ~/.sipag/projects/katulong/roles/test.toml
name = "test"
type = "host"                    # runs on Mac directly
worktree = false                 # tests run against dev's branch
command = "yolo -p 'You are a QA engineer. Run the test suite and report results.'"
```

### Task statuses

Default: `backlog → todo → in-progress → review → done`

Customizable per project. Transitions are monotonic — backward moves are explicit (reopen).

### CLI

```bash
sipag                                    # launch TUI (always, even if empty)

# Feature refinement
sipag feature add "wire up the new dispatcher"   # capture a raw idea
sipag feature list                               # see what's queued
sipag refine f-abc123                            # turn a raw idea into ticket bullets

# Board + dispatch
sipag add "Fix auth bug" -p katulong -l bug
sipag list -p katulong --status todo
sipag move 42 in-progress
sipag dispatch 42                        # spin up role-session, assign task
sipag dispatch 42 --role test            # explicit role override
sipag up katulong                        # spin up all configured roles
sipag projects                           # list all projects
sipag project add katulong --repo dorky-robot/katulong
```

### TUI

k9s-inspired design (consistent with dorky robot visual language):

```
┌─ sipag ─────────────────────────────────────────────────────┐
│ Projects: katulong ● kubo ● sipag ○ diwa ○                  │
├─────────┬───────────────┬──────────┬────────────────────────┤
│ backlog │ in-progress   │ review   │ done                   │
│         │               │          │                        │
│ #23 tab │ #12 links [D] │ #9 copy  │ #7 padding            │
│ #30 kbd │ #18 perf  [P] │          │ #8 latency            │
│         │ #45 smoke [T] │          │                        │
│         │               │          │                        │
├─────────┴───────────────┴──────────┴────────────────────────┤
│ Roles: dev ● (3 agents)  test ● (1)  perf ○  product ○     │
├─────────────────────────────────────────────────────────────┤
│ j/k:nav  enter:detail  d:dispatch  m:move  a:add  ?:help   │
└─────────────────────────────────────────────────────────────┘
  [D]=dev  [T]=test  [P]=perf
```

Design principles (from sipag v1-v3 learnings):
- **Always show real UI** — empty state gets a centered message, never usage text
- **Identity-anchored selection** — track items by stable ID, not position index
- **Operational controls as keybindings** — dispatch, move, kill belong in the TUI
- **No eprintln** — stderr corrupts ratatui. Log to file.
- **Consistent colors** — Yellow=backlog, Cyan=in-progress, Green=done, Red=failed

## Durable Pub/Sub — Design

### Why

The current topic broker is in-memory. When katulong restarts (which happens every `katulong update`), all in-flight messages are lost. Worker exit events, notifications, status updates — gone.

### File-based storage

```
~/.katulong/pubsub/
  sessions/katulong--dev/output/
    log.jsonl              # append-only, one envelope per line
    seq                    # last sequence number (integer)
  crew/katulong/dev/agent-done/
    log.jsonl
    seq
```

Each message gets a monotonic sequence number per topic. Never resets.

### Publish flow

1. Append envelope to `log.jsonl`
2. Increment `seq` file (atomic write)
3. Deliver to in-memory subscribers (for live SSE clients)

### Subscribe flow

1. If `?fromSeq=N`: replay from `log.jsonl` starting at seq N
2. Switch to live SSE for new messages
3. Client tracks its position via seq number

### On restart

Broker reads `seq` files to resume numbering. Subscribers reconnect with their last seq and get everything they missed.

### Rotation

| Topic type | Max size | Retention |
|------------|----------|-----------|
| Terminal output (high-volume) | 1 MB, keep last 2 files | ~minutes of history |
| Events (exit, state changes) | 100 KB | 7 days |
| Notifications | 100 KB | 7 days |

### API (unchanged)

```
POST /pub              → { topic, message }
GET  /sub/:topic       → SSE stream (+ ?fromSeq=N for replay)
GET  /api/topics       → list active topics
```

```bash
katulong pub <topic> [message]
katulong sub <topic> [--once] [--json] [--from-seq N]
```

### Wildcard subscriptions (future)

Directory-based topics enable glob matching:
- `crew/katulong/+/agent-done` → glob `pubsub/crew/katulong/*/agent-done/log.jsonl`
- Merge and sort by timestamp for unified stream

## Terminal Clusters — Live Mini Terminals

When the orchestrator spawns workers, show them as scaled-down live
terminal previews in katulong's web UI. The primitive for this is the
**terminal cluster** — a single carousel card that hosts a CSS grid of
independent mini terminals, each backed by its own tmux session.

### Why separate sessions?

A PTY has exactly one size. The shell and any programs inside it query
their dimensions once, via `TIOCGWINSZ`, and get one answer. There is no
way to have a single running process simultaneously render at 40 columns
(phone) and 200 columns (desktop). Splitting each mini terminal into its
own tmux session with its own PTY is the only way around this — every
slot gets its own resize events, its own shell, its own output stream.

See `docs/cluster-state-machine.md` for the formal lifecycle spec and
`public/lib/tiles/cluster-tile.js` for the implementation.

### Layout

```
┌─────────────────────────────────────────────┐
│ katulong dev                                │
├──────────────┬──────────────┬───────────────┤
│ dev          │ test         │ perf          │
│ ┌──────────┐ │ ┌──────────┐ │ ┌───────────┐ │
│ │$ yolo... │ │ │$ npm t.. │ │ │  (idle)   │ │
│ │fixing #12│ │ │PASS 42/4│ │ │           │ │
│ └──────────┘ │ └──────────┘ │ └───────────┘ │
├──────────────┴──────────────┴───────────────┤
│ 3 active · 1 idle · #12 in-progress         │
└─────────────────────────────────────────────┘
```

Each slot is a real xterm.js instance attached to its own session's
output. Tap to promote to full view. The cluster's front face is the
grid; the carousel's back face is reserved for cluster-level status
(aggregated agent state, task assignments, quick actions) in a future PR.

### Creating a cluster

From the `+` menu → **Cluster**. You'll be prompted for the number of
terminals (2–9). Katulong spins up N new tmux sessions in parallel and
drops them into a grid layout that auto-sizes to the squarest arrangement.

### Future work

- Explicit state machine enforcement (see cluster-state-machine.md)
- Per-slot degradation events wired through session-status-watcher
- Crew integration: sipag dispatches workers that materialize as
  cluster slots with the worker's name pre-filled
- Cluster back-face with aggregated worker status, task assignments,
  and process tree

## Dispatch Flow

What happens when you run `sipag dispatch 42 katulong`:

```
1. sipag reads task #42 → project: katulong, role: dev (default)
2. sipag reads ~/.sipag/projects/katulong/roles/dev.toml
   → type: kubo, container: katulong, worktree: true, command: yolo
3. sipag calls katulong API:
   POST /sessions { name: "katulong--dev" }           (find-or-create)
   → response: { id: "<sid>", name: "katulong--dev" }
4. sipag calls katulong API:
   POST /sessions/by-id/<sid>/exec
   { input: "cd /work/katulong && git worktree add .worktrees/task-42 -b fix/task-42" }
5. sipag calls katulong API:
   POST /sessions/by-id/<sid>/exec
   { input: "cd /work/katulong/.worktrees/task-42 && yolo -p 'Fix task #42: ...'" }
6. sipag updates task #42 → status: in-progress
7. sipag subscribes to crew/katulong/dev/agent-done via pub/sub
8. When agent finishes → hook fires → pub/sub event → sipag moves #42 to review
```

For kubo-hosted roles, step 3 creates the session inside the kubo container (katulong sessions run in tmux inside the container via `kubo katulong`).

## Where things live now

The big architectural moves of the v4 refocus (April 2026):

- **sipag v3 → v4** — the legacy Docker-launching dispatcher path was deleted from sipag in Phase 3a. The Node.js dispatch feature store and refinement engine were ported into Rust as `sipag-core::feature` and `sipag-core::refine` in Phases 3b and 3c, then deleted from katulong in Phase 4 (~3,957 lines removed).
- **hulma extracted from sipag** — the project-scaffolding surface (`sipag configure`, the templates, the agents/commands/hooks) was lifted into its own crate. sipag no longer scaffolds projects; hulma does.
- **Tile plugin system stripped** — katulong's live mini-tile plugin layer was deleted in favor of the simpler **terminal cluster** primitive (one cluster card → CSS grid of independent tmux-backed mini-terminals).

The boundary that came out of all this: **hulma writes files, sipag runs work, katulong hosts the sessions, kubo provides the sandbox.**

## Learnings from sipag v1-v3

These hard-won lessons inform every design decision above:

1. **LLM workers don't know when to stop** — every phase needs entry condition, exit condition, and timeout.
2. **Push judgment to the LLM, keep the tool mechanical** — 3 rewrites, 12k LOC deleted, converged on pure infrastructure.
3. **Unified supervision loop** — don't split heartbeat/worker/monitor into separate threads. One loop owns the lifecycle.
4. **Self-review inside the worker** — review while context is hot, not after.
5. **Monotonic state machine** — backward transitions are no-ops. Prevents race conditions in multi-worker systems.
6. **Crash recovery must be idempotent** — scan for 'running' state on startup, reconcile with reality.
7. **Validate backlog at dequeue** — issues can reference deleted code. Check before dispatching.
8. **File-based state is best** — inspectable with `ls`, crash-recoverable, no database needed.
9. **Don't over-abstract** — v1's plugin system was premature. Start with the simplest thing.
10. **Always show real UI** — k9s pattern. Empty state is valid, never print usage text and exit.
