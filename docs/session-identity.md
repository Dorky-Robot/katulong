# Session Identity — Why Rename Keeps Breaking

## The immediate bug

Renaming a session via the `<tile-tab-bar>` inline-edit UI leaves two
tmux sessions alive: the original under the old name (still running
Claude, still making progress) and a fresh duplicate under the new name
(blank shell, fresh Claude welcome screen). The user sees what looks
like "two terminals connected to the same claude session" — one has the
real work, the other is an empty twin.

The proximate cause is one missing line.

`public/lib/tile-tab-bar.js:458` dispatches a `tab-rename` CustomEvent
when the user commits an inline rename:

```js
this.dispatchEvent(new CustomEvent("tab-rename", {
  bubbles: true,
  detail: { id, oldName: currentName, newName },
}));
```

`public/app.js:1530-1552` handles it:

```js
bar.addEventListener("tab-rename", (e) => {
  const { id, oldName, newName } = e.detail;
  const uiState = uiStore.getState();
  const tile = uiState.tiles[id];
  const desc = describeTile(tile);
  if (!desc.renameable || !desc.session) return;

  if (carousel.isActive()) carousel.renameCard(oldName, newName);
  terminalPool.rename(oldName, newName);
  notepad.rename(oldName, newName);
  windowTabSet.renameTab(oldName, newName);
  invalidateSessions(sessionStore, newName);
  uiStore.removeTile(id);
  uiStore.addTile(
    { id: newName, type: tile.type, props: { ...tile.props, sessionName: newName } },
    { focus: uiState.focusedId === id },
  );
  if (state.session.name === oldName) {
    state.update("session.name", newName);
    setDocTitle(newName);
  }
});
```

There is no `api.put("/sessions/:name", { name: newName })`. The client
relabels every local store but never tells the server. The tmux session
keeps its old name. When the client next tries to attach to the new
name, `sessionManager.attachClient` at `lib/session-manager.js:528-537`
finds no session under that name and cheerfully spawns a fresh one:

```js
let session = sessions.get(name);
if (!session) {
  const newTmuxName = tmuxSessionName(name);
  for (const s of sessions.values()) {
    if (s.tmuxName === newTmuxName) {
      throw new Error("Session name conflicts with existing session");
    }
  }
  session = await spawnSession(name, cols, rows);  // ← new tmux session
}
```

The parallel rename path in `public/lib/shortcut-bar.js:457-470` does
the right thing — it calls the API, handles server canonicalization,
reverts optimistically on error:

```js
api.put(`/sessions/${encodeURIComponent(sessionName)}`, { name: newName })
  .then((result) => {
    const canonicalName = result?.name || newName;
    if (canonicalName !== newName && onTabRenamed) {
      onTabRenamed(newName, canonicalName);
    }
  })
  .catch((err) => {
    console.error("[Tab] Rename failed:", err);
    if (onTabRenamed) onTabRenamed(newName, sessionName);
    render(currentSessionName);
  });
```

Two rename entry points; one calls the API, one doesn't. That's the
whole bug.

## It's not the first time

The one-line fix is straightforward. The interesting question is why
this keeps happening. Running `diwa search katulong "rename session"`
surfaces the same bug class, four separate times, in six weeks:

- **`35fb493` (2026-04-01) — "fix: tab rename creating duplicate tab
  with original name"**. An API response callback and a WebSocket
  broadcast for the same rename created a transient duplicate tab in
  the session list. Fix: apply the rename optimistically *before* the
  API call so the broadcast becomes a no-op. Root cause: two
  notification channels (request-response + pub-sub) for the same
  state mutation.

- **`834f6d1` (2026-04-07) — "Captured field at construction silently
  desyncs on rename"**. `terminal-tile.js` captured `sessionName` once
  in its constructor; `carousel.renameCard` updated the cards map but
  left `tile.sessionName` stale; `findCard` lookups broke on
  `session-removed` and localStorage serialization corrupted. Fix:
  mutable `currentSessionName` closure + `setSessionName()` method
  called from `renameCard`. Lesson quoted from the commit: "any field
  derived from identity that can change must be either re-read through
  a live source or explicitly propagated; construction-time capture of
  mutable identity is a latent bug."

- **`a4c7940` (2026-04-12) — "sync carousel and notepad on WebSocket
  session rename"**. The WebSocket `session-renamed` handler only
  updated the terminal pool and tab set, missing carousel, notepad,
  shortcut bar, and session store. Zombie carousel cards retained the
  old session name; focused-ID lookup failed and jumped to the wrong
  card. Lesson quoted from the commit: "when two code paths produce
  the same logical event (local vs remote rename), they must dispatch
  the identical sequence of effects — divergence between them is a
  recurring source of state drift bugs."

- **`b0c7bf3` (2026-04-13) — "pure selectors + navigation, kill
  state.session.name"**. Without a `uiStoreRename` effect in the
  `session-renamed` WS handler, multi-device rename left uiStore tile
  identity stale; `getActiveSessionName()` kept returning the old
  (dead) name; subsequent WS operations silently targeted the wrong
  session. Lesson quoted from the commit: "when deriving identity from
  a store via selectors, every external mutation path (including
  server-pushed events) must be wired into the store — a missed edge
  leaves selectors returning stale identities with no loud failure."

And the adjacent history of rename-driven friction:

- `eaeb7fb` (2026-03-11, "file browser hidden files toggle and tab
  rename") introduced tab rename and already noted: "always prefer the
  server's canonical response over optimistic client state" — because
  the server sanitizes names via `SessionName` validation and the
  client's raw input can diverge.
- `c13644e` (2026-03-19, "allow all printable ASCII in session names")
  had to decouple display names from tmux-safe names because `. : # %`
  are tmux delimiters; the sanitization was leaking into the UI until
  a one-way mapping was introduced.
- `640d664` (2026-04-06, "Option+R rename") intentionally routed the
  Option+R keybinding into `shortcut-bar.beginRename` rather than
  duplicating the flow, noting "a parallel implementation that could
  drift" as the motivation.
- `063fb46` (2026-03-25, "tab switch duplication") — content
  duplication on carousel tab switch required fixes across four
  files: "no single fix would have been sufficient." The same shape
  as rename: one logical event needs multiple synchronized effects.

Every one of these is the same shape. A rename happens. Multiple data
structures hold the name. One structure doesn't get updated. A later
read through that structure either returns stale data or (worse)
triggers the server to create a new session with the stale name.

## The endemic problem

### Cause #1: Session name is a mutable primary key across many stores

When a session is renamed, the name has to be updated in — at minimum
— these places:

| Store | Location | Keyed by |
|---|---|---|
| Server `sessions` Map | `lib/session-manager.js:48` | name |
| Server `subscriptions` Map (per-client) | `lib/session-manager.js:69` | name (in `Set<sessionName>`) |
| Client tracker | `lib/client-tracker.js:167-171` | name |
| Output coalescer | `lib/output-coalescer.js` | name |
| tmux itself | via `tmux rename-session` | name |
| Client `terminalPool` | `public/lib/terminal-pool.js:302-310` | name |
| Client `carousel.cards` | `public/lib/card-carousel.js:835` | name |
| Client `notepad` | `public/lib/notepad.js:776` | name |
| Client `windowTabSet` (per-window sessionStorage) | `public/lib/window-tab-set.js:178-187` | name |
| Client `uiStore.tiles` | `public/app.js:1543-1547` | tile id (which happens to equal name for terminal tiles) |
| Client `shortcutBar` tab DOM elements | `renameTabEl()` | `data-session` attribute |
| Client `state.session.name` closure (partially removed in `b0c7bf3`) | `public/app.js:1468` | name |
| URL `?s=` param | `public/app.js:1471` | name |
| `document.title` | `setDocTitle()` | name |
| `localStorage["katulong-carousel"]` | persisted from carousel | name |
| `BroadcastChannel` for multi-window sync | `public/lib/window-tab-set.js:187` | name |

A rename is not a single operation. It is the distributed update of
the same field across 15+ independent stores, some in the browser,
some on the server, some in tmux itself, some in persistent storage,
some in other browser tabs via `BroadcastChannel`. There is no
transactional boundary. Ordering matters — `a4c7940` notes that
`carouselRename` must precede `tabRename` because the tab set's notify
callback triggers `reorderCards()` which looks up card IDs that must
already have been updated.

### Cause #2: Every entry point re-enumerates the fan-out by hand

There are at least five places that initiate a rename:

1. `shortcut-bar.js` inline tab rename (legacy imperative bar)
2. `tile-tab-bar.js` inline tab rename (new web-component bar)
3. `session-list-component.js` session list rename
4. `app.js` Option+R keybinding (wraps 1 via `beginRename`)
5. Server-pushed rename via WebSocket `session-renamed`
6. Other-window rename via `BroadcastChannel`

Each of these is a hand-written sequence of 6-10 imperative calls.
Every time a new store is added (`uiStore.tiles` in `b0c7bf3`,
carousel cards in `a4c7940`, etc.), every entry point has to be
updated. CI cannot catch "you forgot one" — the symptom is a silent
drift between two stores that only manifests on a specific user
interaction with a specific combination of features.

### The bug in this worktree, in those terms

The `<tile-tab-bar>` web component was introduced to replace the
legacy imperative tab bar (see `shortcut-bar.js:1033-1036`: "When
ui-store is wired, mount the declarative `<tile-tab-bar>` web
component. It self-manages from the store — no getSessionList() shim,
no activeId derivation, no fitTabLabels() call. One element, one
source of truth.").

When that migration happened, the rename flow was split into two
halves:

- The component fires a `tab-rename` CustomEvent (`tile-tab-bar.js:458`)
- The host app handles it (`app.js:1530`) and was supposed to mirror
  what `shortcut-bar.js:442-471` does

The host handler mirrored eight of the nine steps. It missed the
`api.put`. The component is stateless and correct — it just says "the
user wants to rename this tile, here's oldName/newName." The host is
where the distributed fan-out lives, and the fan-out was transcribed
incompletely.

This is exactly the failure mode `a4c7940` warned about: "when two
code paths produce the same logical event, they must dispatch the
identical sequence of effects." We know the failure mode. We keep
hitting it anyway because the language of rename is "a list of
imperative side effects" rather than "a single state mutation."

## Why this is an architecture problem, not a code-review problem

A code-review culture that catches every missed `api.put` can reduce
the rate, but the underlying setup *makes missed steps the default*.
Consider what a reviewer would need to remember to catch this PR:

1. `tile-tab-bar.js:458` dispatches `tab-rename`
2. Therefore the host must do everything `shortcut-bar.commit()` does
3. Which means `api.put` + canonical-name reconciliation + error
   revert + all nine local stores
4. In the correct order (carousel before tab set before uiStore
   because reorderCards / focus reconciliation depends on it)
5. Plus the `BroadcastChannel` message for other windows
6. Plus not breaking the WebSocket echo path that the server will
   send back when this client's own API call completes

No reviewer holds that in their head across a PR that mostly looks
like UI polish. And even if *this* reviewer did, the next person
adding the next store (which will happen — the project has been
adding tile-adjacent state steadily) won't.

The bug keeps happening because the design keeps asking human
attention to do what a data model should.

## The first-principles fix: surrogate keys

Give every session an immutable `id` at creation time (UUID or
monotonic counter, doesn't matter which). All stores key by `id`.
Name becomes a *field*, not a key. Rename becomes a one-field update
in one store; every view re-derives from that store.

What changes:

- `sessions` Map becomes `Map<id, Session>`; `Session` has `id`,
  `displayName`, `tmuxName`.
- `tmuxName` is derived from `id` (e.g. `kat_<id>`) and never
  changes. The `tmuxSessionName` encoding dance in `lib/tmux.js:15`
  (stripping `. : # % ` to `_`) goes away — display names are free
  text, tmux names are synthetic.
- Client stores (`terminalPool`, `carousel`, `notepad`, `windowTabSet`,
  `uiStore`) all key by `id`. `rename(oldName, newName)` methods go
  away — there is nothing to rename at the key level.
- URL carries `?s=<id>` (or a slugged displayName → id mapping on
  load, decoupled from routing).
- WebSocket messages reference `id`. `session-renamed` becomes
  `{ type: "session-updated", id, displayName }` — the client updates
  one field in one store; all views re-render via subscription.
- The `ctx.currentSessionName` fragility in
  `public/lib/ws-message-handlers.js:123-127` (where the handler
  guesses which session the rename applies to from the client's
  current attachment) disappears — the message carries `id`
  unambiguously.

Renaming in this world is: client sends `PUT /sessions/:id` with
`{ displayName }`. Server updates the `displayName` field. Server
broadcasts `session-updated { id, displayName }`. Clients update
`sessions[id].displayName` in their store. Every subscribed view
re-renders. The tmux session is untouched — its name is derived from
`id` and doesn't change on rename. Zero migration of keys anywhere.

This eliminates all four prior bug classes at the root:

- `35fb493` (double-notification duplicate tab) — no tab is keyed by
  name, so concurrent notifications can't create a duplicate key.
- `834f6d1` (captured sessionName on construction) — tiles key by id,
  which is immutable.
- `a4c7940` (divergent local vs WS rename effect lists) — there is
  only one effect: "set `sessions[id].displayName = newName`." No
  fan-out to forget.
- `b0c7bf3` (uiStore identity drift from server-pushed rename) —
  uiStore tiles key by id; rename never mutates the key.

And the bug in this worktree — the missing `api.put` in
`app.js:1530` — becomes impossible, because there is nothing for the
client to do locally. The rename *is* the server round-trip. No
optimistic path that mirrors a server path to drift from.

## A smaller, nearer-term fix: collapse to one store

If surrogate keys are too large a change (they touch persistence,
URL routing, serialization, the server API, and every tile
renderer), the next-best structural fix is to collapse the
client-side fan-out. The `b0c7bf3` work already started this: pure
selectors deriving focused session from `uiStore` + renderer
registry, killing `state.session.name` as a separately-tracked
field.

Extending that direction:

- `terminalPool`, `carousel.cards`, `notepad`, `windowTabSet` become
  pure renderers of `uiStore.tiles`. They don't hold name-keyed state
  of their own; they read from the store on every render.
- `rename` is a reducer: one action, one store mutation, every
  subscriber re-renders. Entry points fire the action — they don't
  enumerate side effects.
- API call and store mutation are ordered but there is still only one
  mutation site.

This doesn't eliminate the name-as-mutable-key problem (the
`uiStore.tiles` map is still keyed by name for terminal tiles, which
is why rename currently does `removeTile(oldName)` + `addTile(newName)`
in `app.js:1543-1547`). But it reduces the number of places that hold
that key from 15+ to 1. A missed store update becomes structurally
impossible; a missed API call is still possible but now it's a single
obvious check.

## Recommended sequencing

1. **Immediate band-aid (this worktree or a tiny follow-up)** — add
   `api.put` to `app.js:1530-1552` to unblock users hitting the
   duplicate-session bug. Ideally extract a shared
   `renameSession(oldName, newName)` helper that both `shortcut-bar`
   and `app.js` call, so the fan-out exists in exactly one place. Add
   a test that renames via each entry point and asserts the server
   sees exactly one session afterward.

2. **Short-term (one PR)** — complete the `uiStore` consolidation
   started in `b0c7bf3`. Make `terminalPool.rename`, `carousel.rename`,
   `notepad.rename`, `windowTabSet.renameTab` no-ops that derive from
   `uiStore` subscriptions instead of holding their own name-keyed
   state. Rename collapses to a single reducer.

3. **Medium-term (a design + migration PR)** — introduce session
   `id` as a first-class concept. Server assigns UUID on creation.
   Client stores key by `id`. `tmuxName` is derived from `id`. URL
   and WebSocket messages carry `id`. Keep `displayName` as a
   free-text label, mutated by a simple update endpoint.
   Backwards compatibility at the URL layer (resolve `?s=<name>` to
   `?s=<id>` on load) keeps existing links working.

The short-term step is worth doing regardless of whether the
medium-term step happens. The medium-term step is where the bug
class is actually eliminated — not just made harder to hit.

## Minimal test to add now

Whatever the scope of the fix, a test that prevents this specific
regression:

```js
// test/session-rename-entry-points.test.js
// Each rename entry point (shortcut-bar, tile-tab-bar, session-list)
// must produce exactly one tmux session after commit.

test("tile-tab-bar rename persists to server", async () => {
  const session = await createSession("original");
  dispatchTabBarRename("original", "renamed");
  await waitForWSRoundTrip();
  const sessions = await listServerSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "renamed");
});
```

The test would have caught this PR at review time. It also catches
the next entry point that forgets to call the API.
