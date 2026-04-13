# Claude Event Stream — Live Agent Activity via Hooks

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

Users configure Claude Code to POST events to katulong:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "matcher": "",
      "hooks": [{ "type": "http", "url": "http://localhost:3001/api/claude-events" }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{ "type": "http", "url": "http://localhost:3001/api/claude-events" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "http", "url": "http://localhost:3001/api/claude-events" }]
    }]
  }
}
```

This goes in `~/.claude/settings.local.json` (global) or
`.claude/settings.local.json` (project-level).

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

- `katulong setup claude-hooks` CLI command to automate hook config
- Auto-discovery of claude topics in the feed tile picker
- Human-friendly topic names (from Claude's `--name` flag)
- Rich HTML conduit — the feed tile becomes a two-way channel
  to interact with a Claude session
