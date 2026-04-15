# MC1f — Session Meta

A freeform metadata bucket attached to every katulong session, usable by
the server, the UI, the CLI, and external integrations (hook pipelines,
future tools). First consumer: Claude Code presence detection.

## Why

Today a session is `{ id, name, tmuxName, alive, clients, ... }`. There
is no place to hang anything interesting about it. Every time we've
wanted to, we've either:

- Added a new top-level field (`icon`, added ad hoc in the setIcon
  route) — grows the Session surface for every small idea.
- Put it in a parallel store (topics' `meta` in `app-routes.js:75`,
  `iconStore`) — a second source of truth keyed separately, drifting on
  rename.
- Given up and keyed the lookup by session name (the tile → claude
  match that never matches, see `docs/tile-claude-session-link.md`).

None of these scale. The pattern we want is the same one `topic.meta`
already models for claude topics: a small, freeform, per-object bucket.
MC1e gave sessions a stable `id`; MC1f gives them a stable place to
stash facts about themselves.

## Shape

```jsonc
// Session.toJSON() with MC1f:
{
  "id": "V4xQm8pL2tN6bR9cF3aE7",
  "name": "build",
  "tmuxSession": "kat_V4xQm8pL2tN6bR9cF3aE7",
  "tmuxPane": "%3",
  "alive": true,
  "clients": 1,
  "meta": {
    "claude": { "uuid": "ff16582e-bbb4-49c6-90cf-e731be656442", "since": 1713200000000 },
    "user":   { "tags": ["work"], "project": "katulong" },
    "system": { "autoRestart": true }
  }
}
```

Top-level keys are *namespaces*, not content. Three are reserved:

- **`claude`** — written by the hook pipeline. Cleared on `Stop` /
  `SessionEnd`. Never written by users.
- **`user`** — user-supplied tags, project references, arbitrary notes.
- **`system`** — katulong-internal flags (auto-restart, pinned, role).

Any other top-level key is accepted but conventionally under `user`.
Inside a namespace, the shape is whatever the consumer agrees on —
`meta.claude.uuid` is a string because the hook writer and the UI
reader agreed on `uuid`.

## Constraints

- **Total size cap: 4 KB per session.** Enforced at the write path;
  writes that would exceed the cap 413. This keeps `sessions.json`
  small and prevents the bucket from turning into a database.
- **JSON-serializable values only.** No functions, no symbols, no
  cyclic references. Enforced implicitly by the persistence layer.
- **Top-level keys are a fixed vocabulary for now** (`claude`, `user`,
  `system`). Unknown top-level keys at write time are rejected with
  400. This is easy to relax later; starting restrictive keeps the
  namespace disciplined.
- **Writes are merge-patches, not replaces.** `PATCH /sessions/:id/meta
  { claude: { uuid: "..." } }` merges into `meta.claude`; it does not
  overwrite `meta.user`. Explicit deletion uses
  `DELETE /sessions/:id/meta/:namespace/:key` (or
  `.../:namespace` to clear a namespace).
- **`meta.claude` is server-managed.** User writes to the `claude`
  namespace via the public API are rejected. The hook ingestion path
  uses an internal setter that bypasses the public surface.

## API

```
GET    /sessions                   → existing list, now each entry has `meta`
GET    /sessions/:id/meta          → returns the full meta object
PATCH  /sessions/:id/meta          → deep-merge body into meta (user + system only)
DELETE /sessions/:id/meta/:ns      → clear a whole namespace (user + system only)
DELETE /sessions/:id/meta/:ns/:key → clear a single key
```

All are `auth + csrf` wrapped, body cap inherited from `parseJSON`.

WebSocket: existing `session-list` relay already carries the full
session objects, so clients see `meta` on every broadcast. No new WS
message type.

## CLI

Extends `katulong session`:

```
katulong session meta <name>                        # print meta for a session
katulong session meta <name> --json
katulong session meta <name> set user.tags='["work"]'
katulong session meta <name> set user.project=katulong
katulong session meta <name> unset user.tags
```

`katulong session list` grows an optional `--wide` that includes a
`CLAUDE` column derived from `meta.claude.uuid` (short-form) and a
`TAGS` column from `meta.user.tags`.

```
NAME      CLIENTS  ALIVE  CLAUDE    TAGS
build     1        yes    ff16582e  work
edit      2        yes    —         —
```

## Persistence

`sessions.json` entry grows a `meta` field:

```jsonc
{
  "build": {
    "tmuxName": "kat_V4xQ...",
    "id":       "V4xQ...",
    "meta":     { "user": { "tags": ["work"] }, "system": { "autoRestart": true } }
  }
}
```

`meta.claude` is **not persisted** — it's reconstructed from live hook
events on boot. Persisting it risks stale presence ("server says Claude
is running but it died 3 restarts ago"). The `user` and `system`
namespaces persist.

The serializer filters the `claude` namespace out on write. The
restore path leaves `meta.claude` empty until a `SessionStart`
re-populates it.

## Claude presence — the first consumer

This is where MC1f pays off. The hook pipeline already exists
(`lib/cli/commands/relay-hook.js` forwards Claude Code hook events to
the server, which opens `claude/{uuid}` topics). MC1f lets the server
attach the presence signal to the specific session it came from
instead of an orphaned topic.

**Write path (server-internal, on hook ingestion):**

1. `relay-hook` stamps `_tmuxPane` on the payload (cheap:
   `process.env.TMUX_PANE`).
2. Server receives the hook event in `app-routes.js`'s claude topic
   ingest handler.
3. `SessionStart` / first event: look up session by `tmuxPane`, set
   `session.meta.claude = { uuid, since: now }`.
4. `Stop` / `SessionEnd`: clear `session.meta.claude`.
5. Each write triggers the existing debounced `scheduleSave()` (which
   skips the `claude` namespace thanks to the serializer filter).

**Read path (UI):**

```js
// public/app.js (feed button handler, today):
const topic = topics.find(t => t.meta?.sessionName === getActiveSessionName());

// with MC1f:
const session = getActiveSession();
if (session?.meta?.claude?.uuid) {
  openTopic(`claude/${session.meta.claude.uuid}`);
}
```

No picker fallback needed once `meta.claude` is populated.

**Subscription gap (`docs/tile-claude-session-link.md`).** Closing the
"we don't know about Claude until the first tool use" window still
requires subscribing to `SessionStart` in `lib/cli/commands/setup.js`.
That's a one-line addition; tracked with MC1f but not blocking.

## Dependencies

- **MC1e PR1 (merged, `0424ded`)** — `session.id` exists, `/sessions`
  responses carry it. MC1f hangs `meta` off the same envelope.
- **MC1e PR2 (pending)** — adds `tmuxName = kat_<id>` and (per the
  tile-claude-session-link concern) captures `tmuxPane` on Session.
  The `claude` namespace writer keys its lookup on `tmuxPane`, so MC1f
  lands **after** PR2 ships pane capture. Without pane capture there's
  no server-side map from a `SessionStart` event to "which session is
  this?"

## PR split

1. **MC1f PR1 — meta on Session.**
   - Add `this.meta = {}` to Session ctor; `toJSON()` includes it.
   - Persist under `sessions.json` entry; restore on boot.
   - Serializer strips the `claude` namespace on persist.
   - New route: `GET /sessions/:id/meta`, `PATCH /sessions/:id/meta`,
     `DELETE /sessions/:id/meta/:ns[/:key]`. User + system only.
   - 4 KB cap; namespace validation.
   - CLI: `katulong session meta` subcommand.
   - Tests: ctor/persistence round-trip, merge semantics, size cap,
     namespace rejection.

2. **MC1f PR2 — claude presence wiring.**
   - `relay-hook.js` stamps `_tmuxPane` on the payload.
   - `setup.js` subscribes to `SessionStart` / `SessionEnd`.
   - Server hook-ingest handler: look up session by pane, write
     `meta.claude = { uuid, since }` on start; clear on stop.
   - `katulong session list --wide` shows the CLAUDE column.
   - Tests: hook → meta.claude set, Stop → cleared, pane not found →
     no-op, `claude/{uuid}` topic still opens.

## Not in scope

- **Search / query by meta** — no `/sessions?meta.user.tags=work`
  endpoint. First consumer (Claude tile tools) only needs per-session
  lookup. If query ever shows up, do it then.
- **History / audit log** — meta is a live key/value store. Prior
  values are lost on overwrite. The git-history analogue is
  unnecessary; the terminal session itself is ephemeral.
- **Event stream on meta change** — no `session-meta-updated` WS
  message type. `session-list` already broadcasts the whole session
  object on lifecycle changes, which is coarse but sufficient for
  MVP. Revisit if a consumer wants finer-grained deltas.
- **Binary / large values** — attachments, screenshots, arbitrary
  blobs belong in a different store. The 4 KB cap is the wall.

## Open questions

1. **Is `icon` folded into `meta.system.icon`?** Currently it's a
   top-level Session field with its own setter. Folding keeps one
   surface; keeping separate preserves a slightly cheaper hot path.
   Lean: fold during PR1, delete `setIcon` in favor of the meta route.

2. **Should `meta.user` writes require an API key rather than a
   session cookie?** User-supplied tags are not sensitive, but writing
   to a session meta is still a state-changing operation. Session
   cookie + CSRF is the existing bar for other session mutations and
   is probably right here too.

3. **Name collisions between namespaces.** `meta.user.tags` and
   `meta.system.tags` are different buckets; the CLI's `set`
   subcommand needs a dotted-path grammar (`user.tags`). Fine —
   mirrors the shape.

## References

- `docs/session-identity.md` — MC1e's surrogate-id thesis; meta hangs
  off the same `id`.
- `docs/tile-claude-session-link.md` — the first user of
  `meta.claude`; why pane is the right server-side key.
- `docs/claude-event-stream.md` — hook event schema, invariant UUID
  principle.
- `lib/session.js` — Session class (add `meta` here).
- `lib/session-manager.js` — persistence (filter claude namespace).
- `lib/routes/app-routes.js` — mount the new meta routes alongside
  the existing session routes.
- `lib/cli/commands/session.js` — add `meta` subcommand.
