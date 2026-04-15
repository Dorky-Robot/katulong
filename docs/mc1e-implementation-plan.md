# MC1e — Implementation Plan

Companion to `docs/tile-clusters-design.md` MC1e entry and `docs/session-identity.md`.

The MC1e doc says "combine persistence move + surrogate id so there is exactly one migration." That framing is correct for **client-side** work (both parts re-key the same client stores, so one schema bump is cheaper than two). But a **server-side additive id** can land before either client migration without any user-visible change — ids become available and unused until a later PR consumes them.

Split MC1e into 3 PRs. Each ships independently; each is reviewable in one sitting.

## Decisions (confirmed 2026-04-14)

1. **ID format: nanoid.** 21-char url-safe id. Adds `nanoid` dep.
2. **tmuxName: `kat_<nanoid>`.** No sanitization.
3. **`?s=` URL param is deleted entirely, not redirected.** It predates tiles and no longer fits the UI model. PR2 removes both query handling and the server-side redirect idea.
4. **`/sessions/:name` routes deleted on the spot in PR3.** No transition window.
5. **`renameSession()` helper: TBD during PR3.** Decide when the call-site shape is visible.
6. **WebSocket contract.** `session-renamed` → `session-updated { id, displayName }`. Old message type deleted in the same PR that introduces the new one — no protocol backward-compat obligation for WS.
7. **Adoption heuristic.** When adopting an existing `kat_*` tmux session, try to match the suffix against nanoid's alphabet + length; on match, reuse that id. On non-match (pre-PR2 sanitized names, foreign sessions), synthesize a fresh nanoid.

---

## PR1 — Server-side id (additive, no client changes, no migration)

**Scope.** Introduce `Session.id` as an immutable field. Do not change tmuxName derivation yet (existing sessions keep their current sanitized names; new sessions also get sanitized names). Expose `id` in JSON responses and WebSocket broadcasts alongside existing `name`-keyed fields. Clients ignore `id`.

**Why ship alone.** Zero behavior change. Establishes the field shape the migration will consume. Gives the client-side PRs something to ingest.

**Files to change.**

- `lib/session.js`
  - Constructor takes `id` arg. Stores `this.id`.
  - `toJSON()` includes `id`.
  - `stats()` includes `id`.

- `lib/session-manager.js`
  - `spawnSession(name, ...)`: generate `id = crypto.randomUUID()`. Pass into `new Session(name, tmuxName, { id, ... })`.
  - `sessions` Map still keyed by `name` — don't migrate internal lookup structure yet.
  - Add secondary `sessionsById` Map for id→Session lookup. Keep in sync with `sessions`.
  - `attachClient` / `subscribeClient` / any public method that takes `name`: unchanged signature. Internal lookup still via `name`.
  - On adoption path (server restart detects existing `kat_*` tmux session): if tmux session name is `kat_<uuid>` (36-char uuid pattern), extract id from suffix. Otherwise generate fresh id.

- `lib/routes.js`
  - `GET /sessions` already returns array of `toJSON()` — picks up `id` automatically.
  - `POST /sessions` (create): response includes `id`.
  - No new routes in this PR.

- `server.js` / WebSocket bridge
  - `session-added`, `session-removed`, `session-renamed`, `session-updated` broadcasts: include `id` alongside existing fields. Do not remove existing fields.

- `test/session.test.js`, `test/session-manager.test.js`
  - Assert id is generated on `spawnSession`.
  - Assert id survives `renameSession` (name changes, id does not).
  - Assert adopting a `kat_<uuid>` tmux session recovers the same id.
  - Assert adopting a foreign-named tmux session synthesizes a fresh id.

**Out of scope for PR1.**
- No URL routing changes.
- No client-side consumption.
- No tmuxName changes (still sanitized display name).
- No `/sessions/:id` HTTP routes.
- No removal of rename-as-key machinery.

**Risk.** Very low. Additive only. The `sessionsById` Map doubles memory for session metadata (negligible).

**Estimate.** 1 day including tests.

---

## PR2 — Server-side id becomes load-bearing

**Scope.** New sessions use `kat_<uuid>` tmuxName. `tmuxSessionName` sanitization function becomes dead code and is deleted. `/sessions/:id` endpoints added as aliases of `/sessions/:name` (both work). WebSocket session messages switch to id-first, with name as a derived field. Server-side redirect `GET /?s=<name>` → `?s=<id>`. Still no client migration — existing client code keeps using `name` everywhere.

**Why ship separately from PR1.** This is where internal behavior changes (new tmuxName format, routing redirect). Isolating it from the additive PR makes rollback surgical if the new tmuxName format exposes a tmux edge case.

**Files to change.**

- `lib/tmux.js`
  - Delete `tmuxSessionName()`. Replace callers with `"kat_" + id`.
  - Delete conflict-check loop in `session-manager.js:62` (tmuxName is now structurally unique per id).

- `lib/session-manager.js`
  - `spawnSession`: `tmuxName = "kat_" + id`, no sanitization call.
  - Adoption path: existing sessions keep their current tmuxName (may be `kat_<sanitized-name>` from pre-PR2 state). Treat tmuxName as opaque after adoption.

- `lib/routes.js`
  - Add `/sessions/:id` routes for GET/PUT/DELETE. Resolve via `sessionsById`. Keep `/sessions/:name` routes for the PR2→PR3 transition; deleted in PR3.
  - **Delete `?s=` URL param handling entirely.** It predates tiles. No redirect replaces it. `?s=<anything>` is simply ignored after PR2.

- `server.js` WebSocket
  - Outgoing messages: send `{ type: "session-updated", id, displayName }` instead of `session-renamed`. Keep the server accepting legacy outgoing field names for one release if any internal producer still emits them.
  - Incoming messages: accept either `id` or `name` where relevant (same release transition).

- `test/`
  - `/sessions/:id` endpoints work end-to-end.
  - `/?s=<name>` redirects to `/?s=<id>`.
  - Rename via `PUT /sessions/:id { displayName }` does not touch tmux.
  - `tmuxSessionName` deleted — assert the import is gone (grep test).

**Out of scope for PR2.**
- No client-side migration.
- No removal of `/sessions/:name` routes.

**Risk.** Medium. Deleting the sanitization function is the scariest part — if any call site is missed, runtime error. Mitigated by grep test + full test suite.

**Estimate.** 2 days.

---

## PR3 — Client-side migration (the "big" PR)

**Scope.** Persistence move + client re-keying, per the MC1e doc's "combine the two" framing. All client stores re-key by `id`. localStorage schema bumps v3 → v4. Migration reducer reads old name-keyed state and issues fresh ids (or consumes server's `id` mapping if the client has a live WS connection at migration time). Delete `rename()` methods on `terminalPool`, `carousel`, `notepad`, `windowTabSet`, `iconStore`, `sessionStore` — they become no-ops that derive from `uiStore`. Shortcut-bar and `<tile-tab-bar>` read displayName from store, not from tile id. `state.session.name` closure deleted.

**Why ship separately from PR2.** This is the large, risky one. Isolating it means the server-side scaffolding (PR1 + PR2) is already stable; the only new variable is the client migration.

**Files to change.** (abbreviated — final list from diff)

- `public/lib/ui-store.js` — migration reducer v3→v4. Tile ids become session ids, not session names.
- `public/lib/tile-locator.js` — ids are now opaque strings (were display names); no changes except doc.
- `public/lib/card-carousel.js` — cards map keyed by id; `renameCard()` deleted.
- `public/lib/terminal-pool.js` — keyed by id; `rename()` deleted.
- `public/lib/notepad.js`, `public/lib/window-tab-set.js`, `public/lib/icon-store.js`, `public/lib/session-store.js` — same pattern.
- `public/lib/ws-message-handlers.js` — `session-updated` replaces `session-renamed`. One-field update to `uiStore.tiles[id].props.displayName`.
- `public/app.js` — `applyLocalRename` deleted (or reduced to a single `uiStore` dispatch). `tab-rename` event handler becomes a two-liner: API call + dispatch. `state.session.name` deleted; selectors derive from uiStore.
- `public/index.html` / URL handling — remove all `?s=` reading code. Session selection is driven by uiStore/persistence, not URL.

**Tests.**
- Migration reducer: v3 state with known tile names migrates to v4 with synthesized ids; focus preserved; order preserved.
- Rename across all 5 entry points (shortcut-bar, `<tile-tab-bar>`, session-list, Option+R, WS echo): exactly one server-side tmux session afterward (the test from session-identity.md).
- Multi-window rename: BroadcastChannel message carries id; receiving window updates displayName without key migration.

**Risk.** Large. Load-bearing migration. Parallel read path (accept v3 state, rewrite to v4 on load) through one release helps the rollback story.

**Estimate.** 3-5 days including migration testing.

---

## Sequencing and MC3

MC3 (Level 2 cluster strips) is blocked on PR3, not PR1 or PR2. If MC3 gains schedule pressure, PR1 and PR2 can ship first and MC3 can start against the id-aware server API while PR3 is in flight — but MC3's client-side work must not add new name-keyed stores (otherwise PR3 grows).

## Resolved decisions — see "Decisions" section above.
