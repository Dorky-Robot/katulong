# Tile → Claude Session Link — Why the Feed Button Can't Find "Your" Claude

## The user-visible symptom

The Feed tile's RSS button in the tile sidebar is supposed to open a
feed for the Claude Code session currently running in the focused
terminal tile. Today it opens the generic topic picker instead, even
when a Claude session is clearly active in that tile.

The fallback behavior already exists in `public/app.js:1682` —
`openClaudeFeedTile()` queries `/api/topics`, filters by
`meta.sessionName === getActiveSessionName()`, and opens the matched
topic directly. It never matches. Looking at a live topic:

```json
{
  "name": "claude/ff16582e-bbb4-49c6-90cf-e731be656442",
  "meta": {
    "type": "progress",
    "sessionName": null,
    "cwd": "/Users/felixflores/Projects/dorky_robot/katulong",
    "tmuxPane": null
  }
}
```

`sessionName` and `tmuxPane` are always `null`. The match field was
specified but never populated.

## Why nothing populates it

`lib/routes/app-routes.js:75-99` (`ensureTopicMeta`) looks for
`payload.name` and `payload._tmuxPane` in the hook payload. Neither
exists in Claude Code's hook schema. `relay-hook` forwards Claude's
payload as-is and adds no enrichment.

So the field shapes were stubbed out for "someday the hook will carry
a session name / pane id," and someday hasn't arrived.

## Why the naive fix is a trap

Naive fix: enrich `relay-hook` to stamp `_tmuxSessionName` (from
`tmux display -p '#S'`) and `_tmuxPane` (from `$TMUX_PANE`). Server
reads them, the picker match by `sessionName` works.

This collides directly with the concern **`docs/session-identity.md`**
is raising in this worktree. That doc documents four separate
rename-drift bugs in six weeks, all caused by session name being a
mutable primary key spread across 15+ stores. Its recommended fix is
a surrogate immutable `id` per session, with name demoted to a field.

If the tile-to-Claude link is keyed by `sessionName`, then on every
rename it either (a) drifts silently — the client looks up the new
name, server topic still has the old one, no match — or (b) needs to
be added to the fan-out list of 15+ stores the mc1e doc is already
trying to eliminate.

Shorter: **we'd be building a new consumer of the exact mutable key
mc1e is trying to kill, the same week mc1e is trying to kill it.**

## What the tile-to-Claude link actually needs

The link has three ends:

```
  [ Terminal tile in the UI ]
        │  (owns) ──────────►  tile identity
        ▼
  [ tmux session / pane ]
        │  (hosts) ─────────►  tmux pane id (%N) — stable across rename
        ▼
  [ claude process (running now or last run here) ]
        │  (publishes) ─────►  claude session UUID — invariant
        ▼
  [ claude/{uuid} topic in the broker ]
```

Left-to-right: UI → tmux → claude. Each arrow is a mapping that must
not lose identity on rename / reattach / reconnect.

The right end is already solid: `claude/{uuid}` is an invariant key
(see `docs/claude-event-stream.md` principle #2).

The left end is what mc1e is about: tile identity should *not* be
session name; it should be a surrogate id.

The middle is where today's gap lives. Nothing records "which claude
UUID did we last see running in tmux pane %N."

## Why `TMUX_PANE` is the right middle-end key

`$TMUX_PANE` (e.g. `%3`) is assigned by tmux at pane creation and
survives rename, detach, reattach — any lifecycle event short of the
tmux server dying. It's the natural stable anchor for "this specific
terminal slot in this tmux server's lifetime."

The hook runs inside tmux, so `$TMUX_PANE` is always set in its env.
`relay-hook` can stamp it onto the payload at zero cost (just
`process.env.TMUX_PANE`).

The server can then build a pane index:

```
paneIndex: Map<tmux_pane_id, { claudeUuid, startedAt, endedAt }>
```

Updated on every hook event; `Stop` stamps `endedAt`; `SessionStart`
(currently not subscribed — see next section) creates the entry from
turn zero. Lookup: `GET /api/claude-active?pane=%3` returns the live
UUID or `null`.

## The `SessionStart` gap

`lib/cli/commands/setup.js:106` subscribes to
`["PostToolUse", "Stop", "SubagentStart", "SubagentStop"]`.
`SessionStart` is missing, even though
`docs/claude-event-stream.md` lists it as a known hook.

Without `SessionStart`, we don't learn the UUID until the first
*tool* use. A brand-new Claude session that's just chatting with the
user produces no events. The user clicks the feed button, we have no
record of this UUID in the pane index, we fall back to the picker.

Adding `SessionStart` (and `SessionEnd`) to the subscription closes
that window and gives us a clean end-of-life signal too.

## Where mc1e comes in

The missing piece on the katulong side is: how does a terminal tile
answer "what pane am I?" without rope-coupling to session name.

Today the tile has `sessionName`. It has no pane id. If we key the
Claude lookup by `sessionName`, we drift on rename. If we could key
by a stable tile surrogate id (mc1e's proposal), or by a pane id
exposed per session, we wouldn't.

Concretely, **mc1e's session-identity work should produce a stable
accessor the UI can call per tile that returns one of:**

1. The tile's surrogate session id (mc1e's proposed `id` field), which
   the server then resolves to a tmux pane id server-side. Cleanest.
2. The tmux pane id directly, exposed as a tile attribute. Also fine
   — tmux pane id is stable for the same reason an `id` would be.

Either unblocks a robust tile → claude lookup.

If neither ships in the mc1e window, the fallback is to accept
rename-drift and key by `sessionName` with a comment pointing at this
document. We'd have to re-plumb when mc1e lands, which is exactly
what the doc warns against (*"every entry point re-enumerates the
fan-out by hand"*).

## What this worktree (mc1e) needs to decide

To unblock the tile → claude work without creating a drift-prone
coupling:

1. **Will session tiles have a stable id exposed in the UI?** If yes,
   what's its shape (`tile.sessionId`? a selector?), and can hook
   payloads stamp it (via a server-side lookup at ingest time, since
   the hook itself only knows tmux pane)?

2. **Is tmux pane id something the server already knows per session?**
   The session manager creates the tmux session/pane — if it captures
   `%N` at spawn time and stores it in the `Session` object, the
   server can answer `sessionId ↔ pane` lookups without the UI needing
   to know.

3. **Is there a planned `SessionStart`-equivalent for katulong
   sessions** that the Claude event pipeline could hook into, so we
   don't just bolt a separate SessionStart subscription on?

## Minimum change that survives mc1e

If you want to carve a seam now that won't need re-plumbing after
mc1e:

- `relay-hook` stamps `_tmuxPane` only (not `_tmuxSessionName`). Pane
  id survives rename.
- Server stores `tmuxPane` on topic meta.
- `openClaudeFeedTile` asks a new endpoint `GET /api/claude-active`
  that takes whatever identity the tile has (sessionName today,
  sessionId after mc1e) and resolves server-side to a pane, then
  looks up the pane index.

When mc1e replaces `sessionName` with `sessionId` on the tile, only
the query parameter name changes. The claude side is untouched.

## References

- `docs/claude-event-stream.md` — principle #2 (UUID as invariant
  key), hook payload schema, future roadmap (auto-discovery)
- `docs/session-identity.md` — mc1e's core thesis; cause analysis of
  rename drift; surrogate-key recommendation
- `public/app.js:1682` — `openClaudeFeedTile` (the match that never
  matches)
- `lib/routes/app-routes.js:75-99` — `ensureTopicMeta` (the fields
  that never populate)
- `lib/cli/commands/setup.js:106` — hook event subscription list
  (missing `SessionStart`)
- `lib/cli/commands/relay-hook.js` — hook payload forwarder (no
  enrichment today)
