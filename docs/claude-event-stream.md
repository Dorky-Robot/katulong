# Claude Event Stream — Live Agent Activity via Hooks

> **⚠️ Superseded (2026-04-16).** See [`claude-feed-watchlist.md`](claude-feed-watchlist.md) for the current design.
> In the new model hooks are optional, transcript JSONL is the source of truth,
> narration is opt-in via a sparkle-click watchlist, and processing only runs
> while someone is subscribed. This doc is retained for historical context only.
>
> **⚠️ This document was also mid-rewrite (as of 2026-04-14) before being superseded.**
>
> The architecture described below — "thin translator publishes every
> transformed hook event to the topic broker" — has been superseded by a
> **thin-event** model on the `worktree-feed-narrative` branch. In the new
> model, the Claude transcript JSONL on disk is the source of truth, and
> the pub/sub carries only *synthesized* output (narrative chunks,
> completion / attention cards, session summaries) produced by a narrative
> processor. Raw tool-call detail is fetched on demand from the transcript.
>
> Sections that are stale under the new model:
> - Principle #3 ("thin translator") — the `/api/claude-events` handler no
>   longer publishes; it ingests into the narrative processor, which owns
>   all publishing *and* topic creation (lazy — topics only appear once
>   something meaningful is synthesized, so `/clear` / `/resume` / empty
>   sessions no longer clutter the picker).
> - "Translation rules" table — those `step` / `status` mappings still
>   exist inside `lib/claude-event-transform.js`, but they are no longer
>   surfaced on the topic. They're only used as input to the narrative
>   processor's Ollama prompt.
> - "What stays as-is" → feed tile — the renderer code is unchanged, but
>   Claude topics now carry only `narrative` / `completion` / `attention`
>   / `summary` statuses.
>
> Follow-on pieces have now landed: the narrative processor reads
> transcript slices directly, and `GET /api/claude-transcript/:session_id`
> serves on-demand detail (cursor-paginated via `fromLine` / `limit`,
> returns `{ entries, nextCursor, hasMore }`). The transcript path is
> stashed on the topic's server-only meta (`transcriptPath`) and stripped
> from public responses by `publicMeta()` in `lib/routes/app-routes.js`.
> This doc will be fully rewritten once the UI drill-down wiring lands.

## The problem we're solving

Claude Code sessions running inside katulong terminals are opaque.
You can watch the raw terminal output, but there's no structured
view of what Claude is doing — which tools it's calling, when it
finishes a turn, when subagents spawn. The terminal scrollback is
noisy and fast; a status stream would show the high-level activity
at a glance.

Meanwhile, Claude Code already has:

- **Hooks system** — fires HTTP POSTs on 25+ lifecycle events
  (tool use, stop, session start/end, subagent lifecycle, etc.)
- **`http` hook type** — POSTs JSON to a URL on each event.
  Non-2xx responses are non-blocking — a down katulong never
  interferes with Claude.
- **`session_id`** in every hook payload — stable UUID that
  survives renames, persisted at `~/.claude/sessions/$PID.json`

And katulong already has:

- **Topic broker** — durable append-only pub/sub with sequence
  numbers, SSE replay, and topic metadata (`lib/topic-broker.js`)
- **Feed tile** — general-purpose event streamer that subscribes
  to any topic via SSE and renders events as a checklist or log
  (`public/lib/tile-renderers/feed.js`)
- **`POST /pub`** / **`GET /sub/:topic`** — authenticated REST
  endpoints for publishing and subscribing

The pieces exist. We connect them: Claude Code hooks -> katulong
pub/sub -> feed tile.

## First principles

1. **Claude Code hooks are the event source.** We don't parse
   terminal output, poll files, or inject wrapper scripts. The
   hooks system is the supported, structured API for observing
   Claude Code's lifecycle.

2. **The Claude session ID is the invariant key.** Katulong
   terminal sessions can be renamed freely (`/rename`). The Claude
   session UUID never changes. Topics are keyed by this ID:
   `claude/{session-id}`.

3. **The receiver is a thin translator.** A new endpoint
   (`POST /api/claude-events`) receives raw hook payloads and
   publishes transformed events to the topic broker. It doesn't
   store state, make decisions, or buffer — it translates and
   publishes.

4. **The feed tile is the renderer.** No new tile type. The
   existing feed tile subscribes to `claude/{session-id}` and
   renders events using the progress strategy (keyed step updates
   with status bullets).

5. **Graceful degradation.** If katulong is down, hooks fail
   silently (non-blocking). If no feed tile is open, events still
   accumulate in the topic broker for later replay. If hooks
   aren't configured, nothing breaks — there's just no stream.

## Hook payloads — verified field names

Discovered through live testing against Claude Code v2.1.104:

| Hook event        | Key fields                                          |
|-------------------|-----------------------------------------------------|
| `UserPromptSubmit`| `prompt` (string)                                   |
| `PostToolUse`     | `tool_name`, `tool_input` (object), `tool_response` |
| `Stop`            | `last_assistant_message` (string)                   |
| `SubagentStart`   | `description`, `agent_type`                         |
| `SubagentStop`    | `description`, `agent_type`                         |
| `SessionStart`    | `cwd`                                               |
| `SessionEnd`      | (none beyond common fields)                         |

All payloads include: `session_id`, `hook_event_name`,
`transcript_path`, `cwd`, `permission_mode`.

Note: `tool_response` is sometimes a string, sometimes a
structured object (Bash gives `{ stdout, stderr, interrupted }`).

## Translation rules

The transform function (`lib/claude-event-transform.js`) converts
raw payloads into feed-tile-friendly messages:

| Hook event        | `step`                          | `status`   |
|-------------------|---------------------------------|------------|
| `UserPromptSubmit`| `User: {prompt}`                | `active`   |
| `PostToolUse`     | `{tool_name} {target}`          | `done`     |
| `Stop`            | `Claude responded`              | `done`     |
| `SubagentStart`   | `Subagent: {description}`       | `active`   |
| `SubagentStop`    | `Subagent: {description}`       | `done`     |
| `SessionStart`    | `Session started`               | `info`     |
| `SessionEnd`      | `Session ended`                 | `info`     |

Target extraction from `tool_input`:
- Edit/Read/Write: file basename
- Bash: first ~40 chars of command
- Grep/Glob: pattern
- Agent: description

## Hook configuration

Configure Claude Code to relay events via the `katulong relay-hook`
command. This resolves the server URL dynamically from
`~/.katulong/server.json` (localhost) or `~/.katulong/remote.json`
(tunnel URL + API key), so hooks work regardless of which port
katulong is running on:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "katulong relay-hook" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "katulong relay-hook" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "katulong relay-hook" }]
    }]
  }
}
```

This goes in `~/.claude/settings.local.json` (global) or
`.claude/settings.local.json` (project-level).

**Do not hardcode `http://localhost:<port>` in hook URLs.** The port
changes between instances (dev, staging, production) and between
restarts when using dynamic ports. The `relay-hook` command reads the
actual port from `server.json` at invocation time.

## Security

- Auth-protected like `/pub` — requires valid session cookie or
  localhost origin
- Body size limit: 64 KB (hook payloads are small)
- The transform only extracts filenames and truncated summaries —
  never publishes raw tool input/output to prevent leaking
  sensitive file contents

## What stays as-is

- Topic broker — no changes (just consuming it)
- Feed tile renderer — no changes (uses existing progress strategy)
- `remote.json` + API key — no changes

## Future

- Auto-discovery of claude topics in the feed tile picker
- Human-friendly topic names (from Claude's `--name` flag)
- Rich HTML conduit — the feed tile becomes a two-way channel
  to interact with a Claude session
