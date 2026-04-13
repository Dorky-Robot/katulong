# Agent Progress Tile — Live Build Dashboard via Pub/Sub

## The problem we're solving

The kubo sandbox workflow for implementation has too much indirection:

1. Host Claude spawns a background sub-agent
2. Sub-agent runs `docker exec` into the kubo container
3. Sandbox Claude emits stream-json to a log file
4. Host sub-agent polls the log file for progress
5. Host Claude parses grep fragments to relay status to the user

Five layers between "agent does work" and "user sees progress." The
log file is opaque, the git worktree's `.git` pointer gets rewritten
to the container path (breaking host-side git), and the user has no
live visibility unless they ask.

Meanwhile, katulong already has:

- **Topic broker** — durable append-only pub/sub with sequence
  numbers and SSE replay (`lib/topic-broker.js`)
- **`POST /pub`** — authenticated REST endpoint for publishing to
  any topic (`app-routes.js:276`)
- **`GET /sub/:topic`** — SSE endpoint with `fromSeq` replay
  (`app-routes.js:288`)
- **Stable URL + API key** — `remote.json` gives any process
  (host, kubo, CI) a reliable address for the prod katulong
  instance, regardless of which port or container it's in
- **Helm mode** — yolo agents stream structured conversation events
  to the browser via `/ws/helm`
- **Dashboard back-tile** — existing flip-to-see-status pattern on
  terminal tiles (`dashboard-back-tile.js`)

The agent runs in a terminal tile (via yolo). Progress publishes
through katulong's own pub/sub. A progress tile renders the
checklist. No docker exec, no log files, no polling.

## First principles

1. **The agent IS a terminal tile.** Yolo runs inside a katulong
   terminal session. The user can watch it work, scroll back, or
   flip to the dashboard back-face for status. No separate sandbox.

2. **Progress is a pub/sub topic.** The agent publishes structured
   updates via `POST /pub` to the stable URL with Bearer auth. The
   topic broker persists them, assigns sequence numbers, and streams
   to subscribers.

3. **The progress tile is a subscriber.** It opens an EventSource
   to `GET /sub/:topic`, replays from `seq 0` on mount, and renders
   each update as a checklist item. Late openers catch up
   automatically — the broker has replay.

4. **Out-of-band, not in-band.** The agent publishes to the prod
   katulong's stable URL (from `remote.json`), not to localhost.
   This works identically whether the agent runs on the host, in a
   kubo, or on a remote machine. No dev-vs-prod confusion.

5. **Composition, not new infrastructure.** Every piece exists. The
   progress tile is a new renderer that composes EventSource + topic
   broker + the tile system. No new server endpoints, no new
   transport protocols.

## Message format

Each progress update is a JSON string published to a topic:

```js
// POST /pub
{
  topic: "_build/feat-connection-rewrite",
  message: JSON.stringify({
    step: "Tier 1: Pure core",
    status: "done",          // "pending" | "active" | "done" | "error"
    detail: "connection-store.js + heartbeat-machine.js with 23 tests",
    files: ["public/lib/connection-store.js", "public/lib/heartbeat-machine.js"],
    ts: 1712772000000
  })
}
```

The topic broker wraps this in an envelope:

```js
// On disk (log.jsonl) and over SSE
{
  seq: 7,
  topic: "_build/feat-connection-rewrite",
  message: "{...}",   // the JSON string above
  timestamp: "2026-04-10T..."
}
```

### Status values

| Status    | Tile rendering              |
|----------|-----------------------------|
| `pending` | `○` grey bullet             |
| `active`  | `◉` pulsing dot (CSS anim)  |
| `done`    | `●` green bullet            |
| `error`   | `✕` red cross + detail text |

### Topic naming

Convention: `_build/{branch-name}` for implementation work,
`_agent/{session-name}` for ad-hoc agent tasks. The `_` prefix
signals system topics (underscore prefix convention).

## Progress tile renderer

A new tile type: `"progress"`. Stored in `public/lib/tiles/progress-tile.js`.

```js
// Tile descriptor in ui-store
{
  id: "progress-feat-connection-rewrite",
  type: "progress",
  props: {
    topic: "_build/feat-connection-rewrite",
    title: "Connection Rewrite"
  }
}
```

### describe(props) — pure

```js
describe(props) {
  return {
    title: props.title || props.topic,
    icon: "list-checks",    // phosphor icon
    persistable: true,
  };
}
```

### mount(el, ctx) — imperative

On mount:

1. Create the checklist container DOM.
2. Open an `EventSource` to `/sub/${props.topic}?fromSeq=0`.
3. On each SSE `data` event, parse the envelope, parse
   `envelope.message` as JSON, append or update the checklist item.
4. Items keyed by `step` — a second message with the same `step`
   updates the existing item (e.g., `pending` → `active` → `done`).
5. Auto-scroll to the latest item.

On unmount:

1. Close the EventSource.
2. Remove DOM.

### Reconnection

EventSource reconnects automatically (browser built-in). On
reconnect, the broker replays from the last received `seq` via
the `Last-Event-ID` header (SSE standard). No custom reconnect
logic needed.

However, the current SSE endpoint (`app-routes.js:288`) does not
set the `id:` field in SSE events. We need to add it:

```js
// Current (app-routes.js:307)
res.write(`data: ${JSON.stringify(envelope)}\n\n`);

// Change to:
res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
```

And read `req.headers["last-event-id"]` as the `fromSeq` fallback:

```js
const fromSeq = Number(req.query.fromSeq)
  || Number(req.headers["last-event-id"])
  || 0;
```

Two lines added to the existing endpoint. This gives us reliable
replay across reconnects for free via the SSE spec.

## How the agent publishes

The agent (yolo / claude --dangerously-skip-permissions) publishes
via curl to the stable URL. The publish helper is a shell function
the sandbox brief includes:

```bash
# In .sandbox-brief.md or injected via yolo
KATULONG_URL=$(jq -r .url ~/.katulong/remote.json)
KATULONG_KEY=$(jq -r .apiKey ~/.katulong/remote.json)

publish_progress() {
  local step="$1" status="$2" detail="$3"
  curl -s -X POST "$KATULONG_URL/pub" \
    -H "Authorization: Bearer $KATULONG_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"topic\":\"_build/$BRANCH\",\"message\":$(jq -n --arg s "$step" --arg st "$status" --arg d "$detail" '{step:$s,status:$st,detail:$d,ts:(now*1000|floor)}')}"
}

# Usage in the sandbox brief
publish_progress "Tier 1: Pure core" "active" "Starting TDD for connection-store and heartbeat-machine"
# ... do the work ...
publish_progress "Tier 1: Pure core" "done" "23 tests passing, 2 files created"
```

For Claude Code agents specifically, this can also be done via the
Bash tool inside the sandbox session — `curl` is available in both
host and kubo environments.

### Why curl and not a JS import

The agent might be running in any environment: host terminal, kubo
container, remote machine. `curl` + `remote.json` is the universal
interface. No Node.js required, no module imports, no path
assumptions. The stable URL + API key is the only contract.

## Integration with host Claude

Host Claude (the orchestrating session) can subscribe to progress
without polling:

```bash
curl -N -H "Authorization: Bearer $KEY" \
  "$KATULONG_URL/sub/_build/feat-connection-rewrite?fromSeq=0"
```

Each line is a JSON envelope. The host session can stream this via
the Monitor tool or a background Bash command and react to status
changes (e.g., "Tier 1 done, move to Tier 2" or "error, intervene").

This replaces the log-file-polling pattern from the kubo workflow.

## Workflow: end to end

### Setup (once per katulong instance)

```bash
katulong setup self-access
# → creates ~/.katulong/remote.json with { url, apiKey }
```

### Starting an implementation task

1. **Host Claude** creates a worktree:
   ```bash
   git worktree add .worktrees/feat-foo -b feat/foo
   ```

2. **Host Claude** opens a progress tile:
   ```js
   uiStore.addTile({
     id: "progress-feat-foo",
     type: "progress",
     props: { topic: "_build/feat-foo", title: "Feature Foo" }
   }, { focus: false, insertAt: "afterFocus" });
   ```

3. **Host Claude** opens a terminal tile and starts yolo:
   ```bash
   cd .worktrees/feat-foo
   yolo "Read .sandbox-brief.md and follow it"
   ```

4. **Yolo agent** publishes progress as it works:
   ```bash
   publish_progress "Step 1" "active" "Reading design doc"
   # ... work ...
   publish_progress "Step 1" "done" "3 files created, tests passing"
   publish_progress "Step 2" "active" "Wiring app.js boot"
   ```

5. **Progress tile** updates live — user sees checkmarks appear.

6. **Host Claude** subscribes via SSE, gets notified of completion
   or errors without polling.

### What the user sees

Two tiles side by side:

```
┌─────────────────────────┐  ┌─────────────────────────┐
│ Terminal: feat-foo       │  │ Connection Rewrite       │
│                          │  │                          │
│ $ yolo "Read .sandbox-  │  │ ● Tier 1: Pure core      │
│   brief.md and ..."      │  │   23 tests, 2 files      │
│                          │  │ ◉ Tier 2: Imperative...  │
│ [claude working...]      │  │   connection-manager.js  │
│                          │  │ ○ Tier 3: Rewire app.js  │
│                          │  │ ○ Tier 4: Cleanup + CSS  │
└─────────────────────────┘  └─────────────────────────┘
```

The terminal tile shows the raw agent work (scrollable, inspectable).
The progress tile shows the high-level checklist (at a glance).
Flipping the terminal tile shows the dashboard back-face with
process status.

## Build order

### Step 1: SSE `id:` field (2 lines)

Add `id: ${envelope.seq}` to SSE events in `app-routes.js:307` and
read `last-event-id` header as `fromSeq` fallback. This gives
EventSource automatic replay on reconnect.

### Step 2: Progress tile renderer

Create `public/lib/tiles/progress-tile.js`:
- `describe(props)` — pure, returns title + icon + persistable
- `mount(el, ctx)` — opens EventSource, renders checklist, updates
  on each event
- `unmount()` — closes EventSource, removes DOM

Register in the tile renderer registry (or `app.js` tile factory
map, depending on where the tile state rewrite lands).

### Step 3: CSS

Minimal styles for the checklist: status bullets, pulsing animation
for `active`, error styling, auto-scroll container. Follow existing
tile styling patterns.

### Step 4: Sandbox brief template update

Update the `.sandbox-brief.md` template (in the implement-mode
skill) to include the `publish_progress` shell helper and instruct
agents to call it at each step boundary.

### Step 5: Host-side SSE subscription

Add a pattern for host Claude to subscribe to progress via
`curl -N` to the SSE endpoint, replacing log-file polling.

## What gets deleted

- The kubo docker-exec pattern for implementation agents (replaced
  by yolo in a terminal tile)
- Log-file polling from background sub-agents (replaced by SSE
  subscription)
- The `.sandbox-run.log` file convention (progress goes through
  pub/sub, raw output is in the terminal tile)

## What stays as-is

- Topic broker — no changes (just consuming it)
- `POST /pub` endpoint — no changes
- Helm mode — orthogonal (helm renders conversation; progress tile
  renders checklist)
- Dashboard back-tile — complements progress tile (per-session
  status vs. per-task checklist)
- `remote.json` + API key — no changes
- Yolo — no changes needed (it already runs in katulong terminals)

## Out of scope

- Replacing helm mode (helm renders full conversation events;
  progress tile renders a checklist — different purposes)
- Multi-agent orchestration UI (dispatch v2 handles this separately)
- Crew tile integration (crew manages multiple sessions; progress
  tile is per-task)
- Changing the topic broker's retention/rotation policy
- Adding progress publishing to existing CLI commands
