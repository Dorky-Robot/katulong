# Claude Feed — Watchlist Architecture

> **Status:** Design accepted 2026-04-16. Implementation pending.
> Supersedes the hook-driven model in [`claude-event-stream.md`](claude-event-stream.md)
> and the in-memory narrative state machine that preceded it.

## The problem we're solving

The previous design coupled the Claude feed to Claude Code's hook lifecycle.
Hooks set and cleared a `uuid` pointer on the katulong session; a narrative
processor held in-memory state keyed off those hooks; the feed tile watched
that pointer and swapped topics when it changed. Every touchpoint had a
state machine and every state machine leaked across the others.

Symptoms the user actually saw:

- Dismiss a feed tile, re-open it, and recent narrative was "gone" — even
  though the `log.jsonl` on disk had it all along.
- Stop cleared the `uuid`, which left the sparkle in "awaiting Claude"
  mode forever for a session that had just finished talking.
- The processor's rolling-summary state lived in memory, so a server
  restart re-narrated from scratch and double-published.
- Cross-device "catch up" was aspirational — each client assembled its own
  view from whatever the session pointer said at the moment it connected.

Every bug looked different, but they all came from the same place: the
narrator was driven by *events about Claude* (hooks) rather than *Claude's
own output* (the transcript JSONL that Claude writes for itself anyway).

## First principles

1. **The Claude transcript JSONL on disk is the source of truth.**
   Claude writes one line per turn to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.
   It exists whether hooks fire or not. Anything we derive — narrative,
   summary, completion, attention — is a view on that file.

2. **The Claude session UUID is the identity.** Katulong sessions are
   ephemeral; users open and close tiles freely. The UUID survives all of
   that. Everything in this system is keyed by UUID, never by katulong
   session id, cwd, or any other UX-adjacent handle.

3. **Opt-in is explicit and durable.** A UUID is narrated only after a
   user has clicked the sparkle on it at least once. That click is the
   one and only "go ahead, narrate this." It persists to disk and
   outlives server restarts, tile dismissals, and device changes.

4. **Compute happens only while someone is watching.** No daemon loops
   in the background narrating transcripts no one is looking at. When
   the first subscriber connects to `claude/<uuid>`, the processor spins
   up; when the last one leaves, it shuts down. The topic log stays on
   disk regardless — dismissal doesn't erase history.

5. **Every advance is idempotent.** A durable per-UUID cursor records
   the last transcript line the narrator has published. Server restart,
   re-subscription, or unwatch-then-rewatch never re-narrates what's
   already on the topic.

6. **Katulong session meta is a join pointer, nothing more.**
   `session.meta.claude.uuid` exists only to answer "when someone clicks
   the sparkle on this pane, which feed should we open?" It is not
   lifecycle state, it is not ownership, it is never cleared.

## Data model

Three stores, each with one job.

### 1. The watchlist (opt-in ledger)

**Location:** `~/.katulong/claude-watchlist.json`
**Writer:** single writer guarded by state lock, same pattern as auth state.
**Readers:** server, on demand.

```json
{
  "ff16582e-bbb4-49c6-90cf-e731be656442": {
    "addedAt": 1776000000000,
    "transcriptPath": "/Users/felix/.claude/projects/-Users-felix-Projects-foo/ff16582e-bbb4-49c6-90cf-e731be656442.jsonl",
    "lastProcessedLine": 142
  }
}
```

Semantics:
- **Entry exists** → this UUID is watched. Narration is allowed.
- **Entry absent** → never narrated. The transcript on disk is ignored.
- **`lastProcessedLine`** → the cursor. Only advances after a successful
  publish to `claude/<uuid>`. Atomic temp+rename write.
- **`transcriptPath`** → cached at add-time so the processor doesn't have
  to re-discover the cwd slug each tick. Rediscovered lazily if the file
  disappears (Claude moved or deleted it).

### 2. The topic log (the feed itself)

**Location:** `~/.katulong/pubsub/claude/<uuid>/log.jsonl` (already exists).
**Writer:** the narrator, via the existing topic broker.
**Readers:** SSE subscribers via `/sub/claude/<uuid>?fromSeq=0`.

No changes to the topic broker. It already persists, already supports
replay from any seq, already works across devices because it's
server-side. That's why this design is so small — we're just feeding it
a cleaner input pipeline.

### 3. Katulong session meta (the join pointer)

**Location:** `session.meta.claude.uuid` inside `~/.katulong/sessions.json`.
**Writer:** whatever learns the current uuid for a pane — hooks if they
fire, or the sparkle-click scan of the cwd's transcript directory.
**Readers:** the sparkle-click handler on the frontend.

Simplified rules, compared to today:
- **SessionStart / any hook that carries a uuid**: write it. Overwrite freely.
- **Stop / SessionEnd**: do nothing. Leave the pointer where it is.
- **Sparkle click with no current uuid**: scan the pane's cwd for the
  newest `.jsonl` modified in the last ~5 min, adopt that uuid, set the
  pointer, continue.
- **Sparkle click with a stale uuid (transcript gone)**: same scan
  fallback; if nothing, the UI surfaces a "start Claude first" message.

The pointer is never wrong for long and never surprises the user — the
worst case is "sparkle opens yesterday's feed" which is recoverable by
clicking sparkle again after Claude next starts.

## Lifecycle

### Add to watchlist (sparkle click)

```
[User clicks sparkle on katulong session S]
       │
       ▼
[Frontend posts POST /api/claude/watch { sessionId: S }]
       │
       ▼
[Server resolves UUID:
   1. If session.meta.claude.uuid set → use it
   2. Else scan ~/.claude/projects/<slug(S.cwd)>/ for newest .jsonl
      modified < 5 min ago → use that uuid, update pointer
   3. Else return 409 "no active Claude session here" ]
       │
       ▼
[watchlist.json gains { [uuid]: { addedAt, transcriptPath, lastProcessedLine: 0 } }]
       │
       ▼
[Response: 200 { uuid }]
       │
       ▼
[Frontend opens feed tile with topic = "claude/<uuid>"]
       │
       ▼
[Tile subscribes. First subscriber triggers processor.]
```

### The processor (per-UUID, refcounted)

Runs only while at least one subscriber is attached to `claude/<uuid>`.

```
subscribers: 0 → 1  ⟹  spawn processor(uuid)
subscribers: 1 → 0  ⟹  kill processor(uuid)
```

Per-UUID processor loop:

```
loop:
  lineCount = countLines(transcriptPath)
  if lineCount <= lastProcessedLine:
    await fileChange or timeout(polling fallback)
    continue
  slice = readLines(transcriptPath, lastProcessedLine, lineCount)
  events = narrate(slice)               # Ollama call, may take seconds
  for e in events:
    publish("claude/<uuid>", e)         # append to topic log.jsonl
  atomicWriteWatchlist({ ..., [uuid]: { ..., lastProcessedLine: lineCount } })
```

Invariants:

- **Forward-only cursor.** A partial failure leaves the cursor where it
  was; the slice is reprocessed next tick. At-most-once is not promised;
  at-least-once is. Re-published events arrive as fresh seqs on the topic
  and render as duplicates — acceptable, and rare.
- **Single flight per UUID.** Only one processor per UUID, even with N
  subscribers. The narrator serializes Ollama calls per UUID.
- **No global daemon.** If you `ps` the server, you won't see a watcher
  thread. You'll see zero, one, or as-many-as-there-are-watched-UUIDs
  event-loop tasks — scoped to subscription lifetime.

### Subscribe & catch up (view the feed)

```
[Client opens EventSource("/sub/claude/<uuid>?fromSeq=0")]
       │
       ▼
[Server: first active subscriber for this UUID?
   - yes → start processor(uuid) (backfill begins)
   - no  → attach to existing]
       │
       ▼
[Server replays log.jsonl from seq 0 → client]
       │
       ▼
[As processor publishes, new events stream live]
       │
       ▼
[Client disconnects → subscriber count decremented
   - if 0 → processor shuts down
   - topic log stays on disk forever]
```

Two observations:

- A fresh watch (`lastProcessedLine: 0`) on a long transcript pays the
  whole Ollama bill at first subscribe. The client UI should show a
  "catching up…" state until the first event lands. Subsequent
  subscriptions from any device read the already-published backlog
  instantly from `log.jsonl`.
- A client that closes the tab mid-narration does not cancel the
  in-flight Ollama request — we let it finish, publish its output,
  advance the cursor. Otherwise the next subscriber re-pays.

### Remove from watchlist (unwatch)

```
[DELETE /api/claude/watch/:uuid]
       │
       ▼
[watchlist.json loses entry for uuid]
       │
       ▼
[If a processor is running for uuid, kill it cleanly]
       │
       ▼
[log.jsonl stays — the feed remains viewable, just frozen]
```

Unwatch is not a delete. It's "stop narrating further activity." The
feed you built is still on disk and still subscribable. Re-watching
later resumes from the saved cursor (which may be far behind the
current transcript length — the backfill picks up exactly the unread
portion).

## Components

| Piece | File (proposed) | Responsibility |
|---|---|---|
| Watchlist store | `lib/claude-watchlist.js` | Load/save watchlist.json with atomic writes + state lock. Expose `add(uuid, …)`, `remove(uuid)`, `advance(uuid, line)`, `list()`, `get(uuid)`. |
| UUID resolver | `lib/claude-transcript-discovery.js` | Given a cwd, return newest recent `.jsonl`'s UUID and path. Handles Claude's cwd-slug convention. |
| Narrator | `lib/claude-narrator.js` (derived from `narrative-processor.js`) | Pure-ish: given transcript slice + rolling summary, call Ollama, return events. No internal state machine; rolling summary is re-derived each call from the last published `summary` event on the topic. |
| Processor | `lib/claude-processor.js` | Per-UUID refcounted worker. Subscribes to file changes, calls narrator, publishes events, advances cursor. Driven by `topicBroker`'s subscribe/unsubscribe events. |
| HTTP endpoints | `lib/routes/claude-feed-routes.js` | `POST /api/claude/watch`, `DELETE /api/claude/watch/:uuid`, `GET /api/claude/watchlist`, `GET /api/claude/resolve?session=…`. |
| Feed tile | `public/lib/tile-renderers/feed.js` (trimmed) | Pure subscriber. Takes a `topic` prop and streams. `awaitingClaude`, `isNewerSession`, `startedAt`, swap-logic all deleted. |
| Sparkle handler | `public/lib/...` (wherever it lives) | Calls `POST /api/claude/watch` → opens feed tile with returned UUID. |

## What this deletes

On the server:
- `applyClaudeMetaFromHook`'s Stop / SessionEnd branches that clear `uuid`.
- The in-memory debouncer / threshold state in the narrative processor.
  Per-UUID state becomes the topic log itself.
- The ad-hoc "latest summary" cache. The last `summary` event on the
  topic *is* the rolling summary; re-read it when building the next prompt.

On the client:
- `awaitingClaude` view state in `feed.js`
- `isNewerSession`, `startedAt` comparison logic
- The narrating-pill timeout heuristic (it becomes: pill visible while a
  processor is working, invisible otherwise — derived from a small
  `narrating` status heartbeat event the processor emits at start/stop).

In the persistence layer:
- `persistableMeta`'s complexity around `claude.running` / `claude.detectedAt`.
  Those remain pane-monitor telemetry but are no longer entangled with
  feed behavior, so the stripping rule simplifies.

## Non-goals / explicit tradeoffs

- **No push notifications.** "Ping me when Claude stops on this UUID"
  requires a background watcher. Out of scope. A `keep-warm` flag per
  watchlist entry could opt-in later; the design accommodates it (a
  background task that keeps a fake subscriber attached).
- **No retroactive narration of un-watched sessions.** If a user never
  clicked sparkle, the transcript stays unnarrated forever — they can
  opt in later and the full backfill runs at that point.
- **No narration pause / resume within a single watched UUID.**
  Unwatch pauses; re-watch resumes from cursor. A more granular
  "pause narration but keep subscribed" control is not exposed.
- **Slug collisions are accepted.** `/Users/a/foo_bar` and
  `/Users/a/foo-bar` both slug to `-Users-a-foo-bar`. The resolver
  returns the newest-modified `.jsonl` either way; the only user-visible
  consequence is that if both projects have active Claude sessions, the
  "sparkle on pane in foo_bar" might adopt foo-bar's uuid. Vanishingly
  rare; user clicks sparkle again after starting the right Claude.

## Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| Ollama down | Processor's `narrate()` throws. Cursor does not advance. Subscriber sees no new events but the SSE stream stays open. | Processor retries next file-change tick (or periodic heartbeat). Logged. |
| Ollama slow | Long catch-up silence. | Frontend shows "catching up… (N lines)" derived from `lineCount - lastProcessedLine`. |
| Watchlist write fails mid-process | Cursor not advanced. At most one slice re-narrated on next tick. | Topic log gets a duplicate block. Not corrupted. |
| Transcript file deleted by Claude mid-session | Processor logs; next tick's `countLines` fails. | Processor re-resolves via cwd scan. If nothing found, goes dormant until sparkle re-clicked. |
| UUID on watchlist but file doesn't exist at startup | Processor skips it on subscribe; frontend sees empty topic. | Sparkle re-click re-resolves. Watchlist entry lingering on a deleted uuid is harmless. |
| Two devices sparkle the same session simultaneously | Two `POST /api/claude/watch` with same uuid. | State lock serializes. First wins; second is a no-op. |

## Testing strategy

- **Unit**: watchlist store (atomic writes, cursor advance, concurrent add/remove under lock).
- **Unit**: transcript discovery (slug, mtime-window, nonexistent dir).
- **Unit**: narrator (given a transcript slice + summary, assert published events).
- **Integration**: processor lifecycle — spin up subscriber, assert processor starts; drop subscriber, assert processor stops; re-subscribe, assert no duplicate events for already-cursored lines.
- **Integration**: backfill idempotency — watch a uuid, process, unwatch, rewatch → assert no re-publish.
- **Integration**: cross-restart — watch, process N lines, restart server, subscribe → assert resume from cursor.

## Alternatives considered and rejected

### Narrate the terminal tile itself (source-agnostic feed)

We considered making the feed narrate the raw terminal output of a tile —
tmux ring buffer bytes — so the same mechanism could narrate anything:
Claude, builds, deploys, shell sessions. An optional pluggable-source
adapter (`ClaudeSource` reads `.jsonl`, `TerminalSource` reads ring
buffer) would preserve the Claude path while opening the door to generic
narration.

**Rejected.** The generalization is premature and the quality loss for
the Claude case is severe. Claude's transcript gives us clean structured
turns (`{ role, text, tools, tool_result }`) that a narrator can turn
into blog-quality prose. Raw terminal output is the opposite: ANSI
escapes, partial lines, cursor motion, progress bars, and TUIs that draw
UIs rather than emit events. Claude Code's own TUI (permission prompts,
spinners, slash-command picker) looks like noise to an LLM. Shells are
worse — a 10-minute idle followed by `ls` is not narratable material.
Ring buffers are also finite, so long-lived sessions would lose early
context that Claude's on-disk JSONL retains.

We're not building an abstraction for a second use case we haven't
committed to. If terminal-tile narration becomes a real need later, the
watchlist + cursor + refcounted-processor plumbing here generalizes
cleanly — adding a source adapter at that point is a small follow-on,
not a rewrite.

## Out of scope (parked for later)

- Live narration without a subscriber (the "keep-warm" flag).
- Per-event drill-down into the raw transcript line (already partially
  built: `GET /api/claude-transcript/:session_id`).
- UI for viewing the watchlist / unwatching en masse.
- Narrating something other than a Claude transcript (the processor's
  shape — "tail a file, call a model, publish events" — generalizes, but
  we're not building that abstraction yet).
