# MC1f — Session Meta

A server-internal metadata field on every katulong session, with a
single committed consumer: Claude Code presence detection. The shape
is a freeform namespaced bucket so a second consumer can use it
without a schema change — but the public write surface is explicitly
**out of scope for MC1f** and deferred until a second use case exists.

## Why

Today a session is `{ id, name, tmuxName, alive, clients, icon }`. The
tile → Claude feed-button gap (see `docs/tile-claude-session-link.md`)
needs somewhere to hang "is Claude running in this session, and if so,
what UUID." Every previous attempt at per-session state did one of:

- Grew a new top-level Session field ad hoc (`icon`).
- Stored the fact in a parallel store keyed by mutable name (topic
  `meta`, `iconStore`) — drifts on rename, which MC1e just fixed.
- Relied on a broken `sessionName === activeSessionName` match that
  never populates.

MC1e gave sessions a stable `id`. MC1f gives that id a place to carry
presence / state facts. The scope is deliberately narrow: one field,
one internal writer, one internal reader. No public write API,
no CLI subcommand, no `--wide` table column. Those are deferred to
**MC1f.5** (see "Deferred" below) and require a second consumer to
unlock.

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
  "icon": "robot",
  "meta": {
    "claude": { "uuid": "ff16582e-bbb4-49c6-90cf-e731be656442", "startedAt": 1713200000000 }
  }
}
```

Top-level keys inside `meta` are *namespaces*, not content. **In MC1f
only the `claude` namespace is defined.** The namespace vocabulary is
reserved for future use:

- **`claude`** — server-managed. Written by the hook ingest handler.
  Cleared on `Stop` / `SessionEnd`. Not persisted.
- **`user`** — reserved, no writer in MC1f. Unlocked by MC1f.5 when a
  concrete user-meta consumer exists.
- **`system`** — reserved, no writer in MC1f. Same gate.

A `meta` object with only a `claude` entry is the only shape this PR
produces. Unknown namespaces round-trip through persistence but have no
writer.

## Constraints

- **`meta.claude` is not persisted.** On server restart the entry is
  absent until the next Claude hook event arrives. See "Staleness on
  restart" below for the UX tradeoff.
- **No public write API in MC1f.** The HTTP surface exposes `meta` only
  as a read-side field on `GET /sessions`. There is no `PATCH` route.
- **Size guard at the serializer**: the post-merge serialized meta for
  any single session must be ≤ 4 KB. Applies to the `user` / `system`
  namespaces when they exist; moot for MC1f (the single `claude` entry
  is ~100 bytes).
- **JSON-serializable values only.** Enforced implicitly by the
  persistence layer.

## Writers

### `session.setMeta(namespace, value)` — server-internal only

```js
session.setMeta("claude", { uuid, startedAt: Date.now() });
session.setMeta("claude", null);   // clears the namespace
```

Semantics:

- Calling with a value replaces the whole namespace sub-object. (RFC
  7396 merge-patch style deep-merge is **not** implemented in MC1f —
  it's a speculative feature the public PATCH route would need, and
  we're deferring that route. A full-replace setter is one line and
  sufficient for the one caller we have.)
- Calling with `null` removes the namespace entirely.
- Every call triggers the existing debounced `scheduleSave()` and a
  `session-list` broadcast so UI clients see the update without
  waiting for the next lifecycle event.
- Size cap checked against the post-replace serialized size; over-cap
  writes throw (no HTTP surface to 413; this is an internal contract
  violation).

There is no *public* route that invokes `setMeta`. The hook ingest
handler at `lib/routes/app-routes.js` (existing `/api/claude-events`
topic ingest, already auth+csrf-wrapped) is the sole caller.

## Persistence

`sessions.json` entry gains a `meta` field:

```jsonc
{
  "build": {
    "tmuxName": "kat_V4xQ...",
    "id":       "V4xQ...",
    "meta":     {}
  }
}
```

The serializer lives in `lib/session-persistence.js` (the
`createSessionStore` callback invoked from
`lib/session-manager.js`). The callback strips the `claude`
namespace on write. Since `claude` is the only namespace MC1f ever
writes, the persisted `meta` is `{}` for MC1f sessions — but the
shape is load-bearing for MC1f.5 when `user` / `system` get writers.

Round-trip contract: a persisted `meta.user.tags` (hypothetical, not
written in MC1f) must restore identically. Asserted by a persistence
test even though MC1f has no producer for it — pinning the contract
now prevents subtle bugs when MC1f.5 lands.

## Claude presence — the first and only MC1f consumer

### Prerequisite: MC1e PR2 captures `tmuxPane` on Session

MC1f is gated on MC1e PR2, which adds `session.tmuxPane` populated at
spawn time via:

```
tmux list-panes -t <tmuxName> -F '#{pane_id}'
```

run once immediately after `tmuxNewSession` / on adopt, and stored as
`session.tmuxPane`. This is the **authoritative** pane-to-session
index: the server captures it from its own tmux interactions, not from
hook payloads.

### Write path (PR2, `app-routes.js` hook ingest)

1. **`relay-hook.js` stamps `_tmuxPane` onto the payload.** This is
   **new code**, not an existing read-of-env-var. The current
   `relay-hook.js` forwards stdin verbatim; MC1f PR2 adds a small
   payload transform that reads `process.env.TMUX_PANE` (format check:
   `/^%\d+$/`; if absent or malformed, stamp nothing and let the
   server fall back to no-op).
2. **`setup.js` subscribes to `SessionStart` and `SessionEnd`** in
   addition to the existing `PostToolUse` / `Stop` / `SubagentStart` /
   `SubagentStop` list.
3. **Server hook ingest validates pane ownership before writing.** The
   ingest handler does *not* trust `payload._tmuxPane`. Instead it
   looks up the session via the server's own pane index (populated by
   MC1e PR2) and proceeds only if the payload's claimed pane matches
   a live, server-tracked session. Payloads claiming unknown panes are
   a silent no-op.
4. **On `SessionStart`:** `session.setMeta("claude", { uuid, startedAt: now })`.
5. **On `Stop` / `SessionEnd`:** `session.setMeta("claude", null)`.

### Read path (frontend)

```js
// public/app.js (feed button handler) after MC1f PR2:
const session = uiStore.getState().activeSession;
const uuid = session?.meta?.claude?.uuid;
if (uuid) openTopic(`claude/${uuid}`);
else openTopicPicker();
```

The `session` object flows through the existing `session-list`
broadcast, which MC1f triggers explicitly after every `setMeta` call.

### Known gaps — acknowledged, not fixed in MC1f

Three cases where `meta.claude` will not reflect reality; all
acceptable for MC1f and explicitly documented:

- **Server restart with Claude still running.** `meta.claude` is
  unpopulated until the next hook event. For an idle Claude session
  (waiting on user input, no tool calls), that may be a long time or
  never. UX consequence: feed button falls back to the picker for the
  rest of that Claude session. Accepted because the alternative
  (persisting `meta.claude`) risks the worse failure — reporting
  Claude as present when it died mid-restart.
- **Claude started outside the katulong tmux session.** A user who
  runs `claude` from a plain terminal (not inside a katulong-managed
  tmux session) produces hooks with `$TMUX_PANE` either unset or set
  to a pane the server does not own. The ingest handler's pane
  validation rejects these, and `meta.claude` is not populated.
  Accepted because katulong is specifically a web-terminal for
  katulong-managed sessions; out-of-band Claude instances are out of
  scope.
- **Pane ID reuse across session lifetimes.** tmux reuses `%N` after
  pane exit. A stale hook for a killed session racing the creation of
  a new one with the same `%N` is theoretically possible. The pane
  index stored on Session is refreshed on adopt/spawn; cross-checking
  the hook payload's session name against `session.tmuxName` is a
  cheap defense-in-depth step the ingest handler performs in PR2.

## Dependencies

- **MC1e PR1 (merged, `0424ded`)** — `session.id`, listed in
  `/sessions` responses.
- **MC1e PR2 (pending)** — `session.tmuxPane` captured at spawn. MC1f
  PR2 is gated on this; MC1f PR1 can land in parallel but PR2 cannot.

## PR split

### MC1f PR1 — plumbing

Ships the field, the internal setter, and persistence. **No public
HTTP write surface.** `meta` appears as a read-only field on existing
session responses.

- `lib/session.js` — add `this.meta = {}` to the ctor. `toJSON()`
  includes `meta`. New instance method `setMeta(namespace, value)`
  that: validates the namespace is a string, replaces or clears the
  namespace sub-object, enforces the 4 KB serialized cap on the
  whole `meta`, triggers `scheduleSave()` and the `session-list`
  broadcast.
- `lib/session-persistence.js` — the serializer callback in
  `createSessionStore` strips the `claude` namespace on write and
  round-trips everything else.
- `lib/session-manager.js` — the restore path reads `meta` from the
  persisted entry and passes it through the Session constructor.
- Tests: Session ctor accepts persisted meta; `setMeta` round-trip;
  `claude` namespace filtered on persist; size cap rejection; broadcast
  fires exactly once per call.

### MC1f PR2 — Claude presence wiring

Depends on MC1e PR2 (`session.tmuxPane`). Small and isolated.

- `lib/cli/commands/relay-hook.js` — stamp `_tmuxPane` onto the
  payload (format-validated).
- `lib/cli/commands/setup.js` — add `SessionStart` and `SessionEnd`
  to the subscription list.
- `lib/routes/app-routes.js` — hook ingest handler looks up session
  via server-side pane index, validates the payload's pane matches a
  tracked session, calls `session.setMeta("claude", ...)` on start
  and `null` on stop.
- Frontend read at the feed-button call site.
- Tests: hook with known pane → meta.claude set; hook with unknown
  pane → no-op; Stop event → meta.claude cleared; pane format check
  rejects malformed `_tmuxPane`; **pane-reuse defense** — hook whose
  `_tmuxPane` matches a live session but whose payload session-name
  does not match `session.tmuxName` is treated as no-op.

## Deferred to MC1f.5 (requires a second concrete consumer)

Nothing below ships in MC1f. Listed here so the design shape is clear
and the "why not now" is explicit:

- **Public `PATCH /sessions/:id/meta` route.** Needs a real consumer
  to justify RFC 7396 vs. full-replace semantics, and to specify
  which namespaces accept user writes.
- **Public `DELETE /sessions/:id/meta/:ns[/:key]` routes.** Same gate.
- **`katulong session meta` CLI subcommand.** Same gate; also needs a
  grammar decision (dotted paths vs. flat).
- **`katulong session list --wide` with CLAUDE / TAGS columns.** The
  `CLAUDE` column is meaningless until PR2 populates `meta.claude`; a
  dedicated flag for one column is premature. If there's demand, a
  plain `--json` already exposes it.
- **Folding `icon` into `meta.system.icon`.** The fold would break the
  `set-tab-icon` WS message and the existing icon integration test;
  not worth the churn for MC1f. Keep `icon` as a top-level field;
  revisit if a general user-meta consumer emerges.
- **Query-by-meta endpoint**, history log, a dedicated
  `session-meta-updated` WS message type, and binary blobs — all
  explicitly deferred and tracked here.

## Open questions

1. **Should `session-list` broadcasts coalesce meta updates?** A burst
   of Claude hook events (e.g., rapid tool calls) triggers a burst of
   `setMeta("claude", …)` calls. Today each one schedules a separate
   broadcast. If this becomes noisy, add the same debounce the save
   path uses. Deferred until it shows up as a problem.

## References

- `docs/session-identity.md` — MC1e's thesis; the `id` MC1f hangs
  `meta` off of.
- `docs/tile-claude-session-link.md` — the pane-as-middle-key
  rationale; MC1f is the server-side implementation of its
  "minimum change that survives mc1e" proposal.
- `docs/claude-event-stream.md` — hook event schema, UUID invariance.
- `lib/session.js` — Session class (add `meta`, `setMeta`).
- `lib/session-persistence.js` — serializer (add `claude` filter).
- `lib/session-manager.js` — restore path (pass persisted meta into
  ctor).
- `lib/routes/app-routes.js` — existing hook ingest handler (PR2
  callsite for `setMeta`).
- `lib/cli/commands/relay-hook.js` — existing payload forwarder (PR2
  adds `_tmuxPane` stamping).
- `lib/cli/commands/setup.js` — hook subscription list (PR2 adds
  `SessionStart` / `SessionEnd`).
