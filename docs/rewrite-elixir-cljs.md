# Rewrite: Elixir backend + ClojureScript frontend

## Summary

Katulong started as a Node.js spike for a self-hosted web terminal and has
grown into a full remote-work surface: tmux sessions, a 3D tile grid, a file
browser, a Claude transcript feed, Ollama-backed summarization, WebRTC
signaling, pub/sub topics, WebAuthn auth, a port proxy, and more. The Node
implementation has served the spike well, but the concurrency model (single
event loop with ad-hoc locking) is now the main source of subtle correctness
issues — race conditions in auth state, client-tracker drift, tmux resize
storms, buffer desync recovery, per-tab summarizer coordination, etc.

This document is the plan for a **rip-the-bandaid rewrite** to Elixir/OTP on
the backend and ClojureScript (shadow-cljs + re-frame) on the frontend,
keeping xterm.js and a handful of WebKit-specific JS helpers as raw JS
interop.

> **Scope honesty.** The katulong codebase is substantially larger than its
> original "web terminal" charter. The `lib/` tree currently holds ~60
> backend modules, `public/lib/` holds ~75 frontend modules, and the test
> suite has ~146 files across unit/integration/e2e. A faithful rewrite is a
> multi-month effort. Before starting, confirm the answers to the decisions
> in [§13 Open questions](#13-open-questions).

---

## 1. Current state

### Backend (`server.js` + `lib/`)

- **Session/tmux**: `session-manager.js`, `session.js`, `tmux.js`,
  `client-tracker.js`, `tmux-output-parser.js`, `output-coalescer.js`,
  `ring-buffer.js`, `screen-state.js`
- **Auth**: `auth.js`, `auth-state.js`, `auth-repository.js`,
  `auth-handlers.js`, `auth-tokens.js`, `credential-lockout.js`,
  `http-util.js`
- **Claude integration**: `claude-processor.js`, `claude-watchlist.js`,
  `claude-session-discovery.js`, `claude-transcript-discovery.js`,
  `claude-pane-scanner.js`, `claude-event-transform.js`,
  `claude-permissions.js`, `claude-hooks.js`, `claude-narrator.js`
- **File browser**: `file-browser.js`, `container-detect.js`
- **LLM**: `ollama-client.js`, `session-summarizer.js`
- **WebRTC**: `webrtc-signaling.js`, `client-transport.js`
- **Pub/sub**: `topic-broker.js`, `agent-presence.js`
- **Persistence**: `session-persistence.js`, `config.js`, `shortcuts.js`,
  `env-config.js`, `env-filter.js`
- **Transport**: `ws-manager.js`, `transport-bridge.js`, `server-upgrade.js`,
  `websocket-validation.js`, `request-util.js`
- **Routes**: `lib/routes/*.js` (auth, app, file browser, port proxy, notes,
  claude feed, notifications, pub/sub)
- **Lifecycle**: `server-shutdown.js`, `plugin-loader.js`
- **Utilities**: `rate-limit.js`, `static-files.js`, `drift-log.js`,
  `port-proxy.js`, `session-name.js`, `id.js`, `log.js`, `result.js`,
  `paste-sequence.js`, `tmux-socket-sweep.js`, `session-child-counter.js`,
  `session-meta-filter.js`, `topic-broker.js`, `access-method.js`,
  `terminal-config.js`

### Frontend (`public/`)

- SPA bootstraps from `public/app.js` (~2900 lines) into `<div id="app">`
- State layers:
  - `ui-store.js` — spatial 3D tile grid (`clusters[c][col][row]`) + derived
    flat `tiles` map and `order` list
  - `stores.js` — session list, selection, shortcuts
  - `connection-store.js` — WS connection state, scroll preservation
  - `reconciler-store.js` — sequence/fingerprint-based desync detection
  - `terminal-pool.js` — per-session xterm.js instance cache
- Renderers registered under `public/lib/tile-renderers/` (terminal, file
  browser, image, document, feed, cluster, localhost browser, progress)
- Transport: single WS opened on boot (`connection-manager.js`), routed
  through `ws-message-handlers.js`, WebRTC DataChannel upgrade optional
  (`webrtc-peer.js`)
- Login flow in `public/login.html` + `public/login.js` using
  `@simplewebauthn/browser`
- Service worker in `public/sw.js` for PWA installability
- Vendored deps in `public/vendor/`: xterm, codemirror, marked, dompurify,
  phosphor-icons, simplewebauthn, fonts

### External processes

- **tmux** (per session, long-lived, control mode)
- **Ollama HTTP** at `localhost:11434` (feed narrator + per-tab summarizer)
- **ps / pgrep** (one-shot, boot-time)
- **Claude CLI transcripts** (file polling, not process spawn)

### Tests

- 122 `*.test.js` (Node `node --test`, experimental module mocks)
- 11 `*.integration.js`
- 13 `*.e2e.js` (Playwright)
- 1 garble-detection harness
- Pre-push hook runs the suite; `--no-verify` is explicitly forbidden by
  `CLAUDE.md`

---

## 2. Target state

### Stack

| Layer | Current | Target |
|---|---|---|
| Backend language | Node.js 18+ | Elixir 1.16+ on OTP 26+ |
| Backend framework | Custom HTTP + `ws` | `Phoenix` 1.7 (Bandit HTTP, Channels WS) |
| Process model | Single event loop | OTP supervision trees |
| Session state | In-memory `Map` + JSON files | `GenServer` per session, ETS for indexes, `DETS` or files for durable state |
| Auth state | JSON files + `withStateLock` | `GenServer` serializer, atomic temp+rename, optional `Ecto` + SQLite later |
| Persistence | Debounced JSON writes | Same pattern wrapped in a `GenServer`, or `CubDB`/SQLite if we want queries |
| LLM client | `ollama-client.js` | `Req`-based HTTP client |
| WebRTC | `node-datachannel` (optional) | Defer — keep WS-only in v1 |
| Packaging | npm + `bin/katulong` wrapper | `mix release` tarball (single binary, embedded ERTS) |
| Frontend language | Vanilla JS (ES modules) | ClojureScript via shadow-cljs |
| Frontend state | Ad-hoc stores + 3D grid | re-frame (single app-db atom + events/subs/fx) |
| Frontend routing | Hash-free SPA | reitit-frontend (or keep hand-rolled) |
| Frontend interop | N/A | `js/` namespace + shadow-cljs `:npm-module` for xterm/codemirror |
| Build | Static `public/` served as-is | shadow-cljs release → `priv/static/` served by Phoenix |

### Shape

```
katulong/
├── apps/                       (umbrella optional; flat app if simpler)
│   ├── katulong/               (core: sessions, auth, claude, feed)
│   └── katulong_web/           (Phoenix: routes, channels, plug)
├── assets/                     (frontend source)
│   ├── shadow-cljs.edn
│   ├── src/
│   │   └── katulong/
│   │       ├── app.cljs        (entry)
│   │       ├── events.cljs     (re-frame events)
│   │       ├── subs.cljs       (re-frame subs)
│   │       ├── fx.cljs         (side-effects, WS, xterm interop)
│   │       ├── tiles/          (per-renderer namespaces)
│   │       └── js/             (imperative interop: xterm, paste, clipboard)
│   └── package.json            (xterm, codemirror, marked, dompurify, simplewebauthn)
├── config/                     (Elixir config)
├── lib/                        (Elixir source)
├── priv/
│   ├── static/                 (compiled CLJS → JS, vendored assets)
│   └── repo/                   (if Ecto)
├── test/                       (ExUnit + Playwright under test/e2e/)
├── mix.exs
└── bin/katulong                (wrapper around `mix release` output)
```

---

## 3. Approach: rip the bandaid

No side-by-side operation. No incremental cutover. The rewrite lives on the
`rewrite-elixir-cljs` branch until it reaches feature parity with `main`,
then it replaces `main` in a single merge.

**Why this over staged migration:**

- Two backends speaking the same WS protocol means carrying two auth
  implementations, two persistence layers, two bug trails. The coordination
  cost exceeds the risk it would mitigate.
- Katulong is self-hosted, single-user-per-instance. There is no "rolling
  deploy" constraint that forces parallel running.
- The branch is held behind a clean cutover commit, so rollback = `git
  revert` (or just stop upgrading past the cut).

**What rip-the-bandaid does *not* mean:**

- It does not mean skipping tests. Parity requires parity tests.
- It does not mean skipping the WS protocol freeze. Freezing the protocol
  first is what lets the frontend and backend be built in parallel inside
  the branch.
- It does not mean deleting the Node code on day 1. The Node code stays in
  place as the living spec until the Elixir side passes all parity tests,
  then it's deleted in one commit.

---

## 4. First gate: freeze the WebSocket and HTTP contracts

Before writing any Elixir, the wire contracts become canonical docs under
`docs/protocol/`. This is the only document both the frontend and backend
read from.

### 4.1 WebSocket messages

Document every message type with fields, direction, and semantics. Source of
truth is the existing code; extract via reading `lib/ws-manager.js`,
`lib/transport-bridge.js`, `lib/topic-broker.js`,
`public/lib/ws-message-handlers.js`, and `public/lib/transport-layer.js`.

Server → Client: `output`, `exit`, `session-updated`, `session-removed`,
`session-renamed`, `state-check`, `seq-init`, `data-available`, `attached`,
`resize-sync`, `child-count-update`, `paste-complete`, `open-tab`,
`notification`, `topic-new`, `device-auth-request`, `credential-registered`,
`error`.

Client → Server: `attach`, `input`, `resize`, plus WebRTC signaling messages
(if we keep WebRTC in v1).

For each message: exact JSON shape, when it fires, ordering guarantees, and
whether it participates in the reconciler's seq/fingerprint protocol.

### 4.2 HTTP routes

Document every route, its auth level (public / session / bearer / localhost
only), request body shape, response shape, and error codes. Source of truth:
`lib/routes/*.js`.

### 4.3 Session metadata schema

Move the free-form `meta` bucket (Claude UUID, user title, auto summary,
child count, etc.) into an explicit, versioned schema. Both sides validate
against it. Migration from the existing free-form shape happens once during
cutover.

### 4.4 Acceptance criteria for the freeze

- A new contributor can implement a client from the protocol doc without
  reading the JS source.
- Every existing integration test references the doc by anchor.

---

## 5. Backend architecture (Elixir/OTP)

### 5.1 Supervision tree

```
Katulong.Application
├── Katulong.Config                       (Agent or :persistent_term)
├── Katulong.Auth.Supervisor
│   ├── Katulong.Auth.Store               (GenServer, serializes auth state)
│   ├── Katulong.Auth.ChallengeStore      (GenServer, 5-min TTL cache)
│   └── Katulong.Auth.Lockout             (GenServer, 15-min sliding window)
├── Katulong.Sessions.Supervisor          (DynamicSupervisor)
│   └── Katulong.Sessions.Session         (GenServer per tmux session)
│       ├── Port to `tmux -C` control mode
│       ├── RingBuffer state
│       ├── ClientTracker state
│       └── ScreenState / headless emulator
├── Katulong.Topics.Supervisor
│   └── Katulong.Topics.Topic             (GenServer per pub/sub topic)
├── Katulong.Claude.Supervisor
│   ├── Katulong.Claude.Watchlist         (GenServer, drives refcount polling)
│   ├── Katulong.Claude.SessionDiscovery  (GenServer, periodic ps scan)
│   ├── Katulong.Claude.TranscriptWatcher (one GenServer per watched transcript)
│   └── Katulong.Claude.Narrator          (shared Ollama client)
├── Katulong.FileBrowser.Supervisor
│   └── Katulong.FileBrowser.ContainerDetect (GenServer, cached)
├── Katulong.Persistence.Supervisor
│   ├── Katulong.Persistence.Sessions     (debounced writer)
│   ├── Katulong.Persistence.Shortcuts
│   └── Katulong.Persistence.Config
├── Phoenix.PubSub
└── KatulongWeb.Endpoint                  (Bandit + Phoenix)
    ├── HTTP plug pipeline (auth, rate limit, headers)
    └── Channels: "session:*", "topic:*", "auth:*", "claude:*"
```

### 5.2 Session lifecycle mapping

| Node concept | OTP equivalent |
|---|---|
| `new Session(...)` in `session-manager.js` | `DynamicSupervisor.start_child(Sessions.Supervisor, {Session, args})` |
| `session._tmuxProc.on('exit', ...)` | `Port` close → GenServer crashes → supervisor decides |
| `withStateLock()` around auth writes | `GenServer.call(Auth.Store, {:mutate, fn})` |
| `ClientTracker.markActive()` | `GenServer.cast(session, {:mark_active, client_id})` (serialized, no race) |
| `subscribe(sessionId, client)` | `Phoenix.PubSub.subscribe("session:#{id}")` + client joins channel |
| Output fanout to WS clients | `Phoenix.PubSub.broadcast` → all channels for the topic push to their sockets |
| Session persistence debounce | `GenServer` with `:timer.send_after/3`, cancel-and-reset on each mutation |

### 5.3 tmux integration

The one truly load-bearing piece of the backend. The existing JS code
handles:

- Hex-encoded send (`send-keys -H`)
- Octal-escaped `%output` parsing, with partial UTF-8 sequences carried
  across lines
- Seq-number fingerprinting for desync detection
- Resize arbitration across multiple attached clients (one PTY size)
- Socket lifecycle (dedicated socket per session — see `fix/tmux-dedicated-socket`)

Elixir plan: **wrap system `tmux` as a `Port`**, port the parser verbatim
from `tmux-output-parser.js` into Elixir. The parser is pure data
transformation and has strong tests — it's the safest part to port first.

Open question: whether `ScreenState` / `output-coalescer` / headless xterm
emulation can be replaced with a pure-Elixir terminal emulator (e.g. a port
of `@xterm/headless`), or whether we keep a companion Node process just for
headless emulation in v1. See [§13](#13-open-questions).

### 5.4 Channels vs custom WS

Use `Phoenix.Channel` — its topic multiplexing matches exactly what
`ws-manager.js` hand-rolled. A browser opens one `Socket`, joins
`"session:<id>"` for each subscribed tile, and leaves on tile removal.
Phoenix handles backpressure, reconnect, and replay buffering.

### 5.5 Auth

- WebAuthn via `wax` or a hand-rolled RP. `simplewebauthn` on the client is
  kept (it's already vendored).
- Session cookies: `HttpOnly`, `SameSite=Lax`, 30-day sliding expiry.
- Localhost bypass preserved exactly from `access-method.js` — **check both
  socket peer and Host/Origin headers** per the security model.
- State store: `GenServer` writes JSON with atomic temp+rename, identical
  shape to current files so the migration is a one-time rename of the
  storage directory.
- Rate limit: port `rate-limit.js` as a GenServer-backed token bucket.

### 5.6 Claude feed / narrator / summarizer

- Replace the refcount-driven polling loop with one `GenServer` per watched
  transcript. Idle polling cancels via supervisor.
- The per-tab summarizer and feed narrator continue to share a single
  Ollama HTTP client (per the memory note about `gemma4:31b-cloud`). In
  Elixir this is a single `GenServer` fronting `Req` with request queueing.
- The "Claude processor" state machine becomes a module with pure
  reducer functions + a GenServer that drives them. This makes the existing
  `claude-processor.test.js` translatable almost line-for-line.

### 5.7 Persistence

- Session metadata, shortcuts, config: same JSON files in the same
  locations. Writers are GenServers with debounced flush.
- Future option: swap in `CubDB` or SQLite for query-ability, but not in v1.

### 5.8 Release + deployment

- `mix release --overwrite` produces a tarball with embedded ERTS.
- `bin/katulong` wrapper script invokes the release, preserving today's
  CLI surface (`katulong start`, `katulong setup-token`, etc.).
- Homebrew formula updated to install the release tarball instead of
  npm-linking `bin/katulong`.

---

## 6. Frontend architecture (ClojureScript)

### 6.1 shadow-cljs configuration

- One build target `:app` compiling `katulong.app/init` to
  `priv/static/app.js`.
- `:npm-module` for xterm, codemirror, marked, dompurify,
  @simplewebauthn/browser. These stay on npm — no need to vendor compiled
  CLJS artifacts of things that already work in JS.
- Separate build target `:login` for `public/login.html` (smaller bundle).
- Dev: `shadow-cljs watch app login`, hot reload into the Phoenix dev
  server.

### 6.2 re-frame structure

- **app-db** — single source of truth, replacing the union of `ui-store`,
  `stores`, `connection-store`, `reconciler-store`, and `terminal-pool`
  metadata. xterm.js instances themselves still live in a `defonce`
  registry outside app-db (they are mutable objects, not data).
- **Events** — one namespace per concern (`events.session`, `events.tiles`,
  `events.auth`, `events.feed`). Events are pure `(fn [db event] ...)` that
  produce effects.
- **Subs** — selectors equivalent to `public/lib/selectors.js`, but
  memoized by re-frame.
- **Effects** — a `:ws/send` effect for outgoing messages, `:xterm/write`
  for writing into a terminal instance, `:storage/set` for localStorage.
- **Coeffects** — `:now`, `:localStorage`, `:xterm/serialize` for tests and
  replay.

### 6.3 Tile rendering

- Tile-renderer registry becomes a CLJS multimethod dispatched on
  `:tile/kind`.
- Terminal tile: Reagent component that mounts a `<div>` and, on
  `component-did-mount`, instantiates xterm.js from the JS interop layer.
  Further data flows are `(.write term chunk)` calls in an effect handler.
- File browser, document, image, feed, cluster, localhost, progress —
  each a Reagent namespace under `katulong.tiles/*`.

### 6.4 JS interop islands

Kept as raw `.js` files under `assets/src/katulong/js/`:

- `paste-handler.js` — three-layer keyboard/paste/Clipboard-API interception
  (see `docs/clipboard-bridge.md`). WebKit-fragile; do not port.
- `image-upload.js` — paired with paste-handler for the image path.
- `early-scroll-lock.js` — must run before first paint, kept as a plain
  script tag in `index.html`.
- `color-math.js`, `scroll-utils.js` — pure algorithms, port opportunistically
  later; no rush.

### 6.5 Service worker

Port `public/sw.js` verbatim as a plain JS file served from
`priv/static/`. It's tiny and has no CLJS value-add.

---

## 7. Subsystem parity matrix

Every entry is something the rewrite must reproduce. Order is rough
difficulty, hardest first.

| # | Subsystem | Source (Node) | Target (Elixir/CLJS) | Parity test source |
|---|---|---|---|---|
| 1 | tmux control mode I/O | `tmux.js`, `session.js`, `tmux-output-parser.js` | `Katulong.Tmux` + `Katulong.Sessions.Session` | `session.test.js`, `tmux-output-parser-utf8-split.test.js`, all `garble-*.test.js` |
| 2 | Client tracker + resize arbitration | `client-tracker.js` | `Sessions.Session` internal state | integration: `pch2-attach-subscribe`, `terminal-pool-scale` |
| 3 | Output reconciler (seq + fingerprint) | `reconciler-store.js` + server seq | re-frame event chain + server-side seq | `reconciler-store.test.js`, `garble-subscribe-snapshot.test.js` |
| 4 | WebAuthn flows | `auth.js`, `auth-handlers.js`, `auth-repository.js` | `KatulongWeb.AuthController` + `Auth.Store` | `auth.test.js`, `auth-handlers.test.js`, `toctou-register-verify.integration.js` |
| 5 | Session persistence + migration | `session-persistence.js` | `Persistence.Sessions` | `session-persistence.test.js`, `session-prune.test.js` |
| 6 | WebSocket channel multiplexing | `ws-manager.js`, `transport-bridge.js` | `KatulongWeb.SessionChannel` + `Phoenix.PubSub` | `ws-manager.test.js`, `websocket-subscribe.test.js`, `transport-bridge.test.js` |
| 7 | Pub/sub topics | `topic-broker.js` | `Katulong.Topics.Topic` | `topic-broker.test.js`, `pubsub.integration.js` |
| 8 | Claude feed + narrator | `claude-*.js` | `Katulong.Claude.*` | `claude-*.test.js` |
| 9 | File browser | `file-browser.js`, `container-detect.js` | `Katulong.FileBrowser` | `file-browser.test.js`, `file-browser-tile.test.js`, `file-image-read.test.js` |
| 10 | Port proxy | `port-proxy.js` | `KatulongWeb.ProxyController` | `port-proxy.test.js` |
| 11 | Session summarizer | `session-summarizer.js` | `Katulong.Claude.Narrator` | `session-summarizer.test.js` |
| 12 | Rate limiting | `rate-limit.js` | plug + GenServer | `rate-limit.test.js` |
| 13 | Credential lockout | `credential-lockout.js` | `Auth.Lockout` | `credential-lockout.test.js` |
| 14 | WebRTC signaling | `webrtc-signaling.js` | **Deferred** — remove from v1 unless needed | `webrtc-signaling.test.js` |
| 15 | Tile grid state | `ui-store.js` | re-frame `:tiles` + `:clusters` | `ui-store.test.js`, `cluster-*.test.js`, `window-tab-set.test.js` |
| 16 | Terminal rendering | `terminal-pool.js` + `tile-renderers/terminal.js` | `katulong.tiles.terminal` | `term-update-client.test.js`, `terminal-tab-handler.test.js` |
| 17 | Paste + clipboard bridge | `paste-handler.js`, `image-upload.js` | **Keep as JS** (interop) | `paste-handler.test.js`, `clipboard-bridge.test.js` |
| 18 | Shortcut bar + key mapping | `shortcut-bar.js`, `key-mapping.js`, `terminal-key-decider.js` | `katulong.shortcuts` | `shortcuts.test.js`, `keyboard-spec.test.js`, `key-island.test.js` |
| 19 | Connection manager | `connection-manager.js` | re-frame ws fx + reconnect | `connection-store.test.js` |
| 20 | Service worker | `sw.js` | Keep verbatim | — |
| 21 | Plugin loader | `plugin-loader.js` | **Deferred** — likely unused in v1 | — |

Anything in the frontend not listed above (the ~75 small files under
`public/lib/`) is derived from the stores and will re-materialize naturally
once re-frame and the tile registry are in place.

---

## 8. Test strategy

### 8.1 Three test tiers

1. **Pure Elixir (ExUnit)** — ports of the Node unit tests that are already
   pure data: `tmux-output-parser`, `ring-buffer`, `paste-sequence`,
   `output-coalescer`, `rate-limit`, `result`, `session-name`, `env-config`,
   `env-filter`, `http-util` helpers. These should be near-1:1 translations
   and are the first thing written.
2. **Phoenix integration (ExUnit + `Phoenix.ChannelTest`)** — ports of the
   `*.integration.js` suite. Same scenarios, same WS protocol, against the
   Phoenix endpoint.
3. **E2E (Playwright)** — the existing `test/e2e/*.e2e.js` suite is
   language-agnostic: it drives a real browser against a running server.
   These stay **as-is** and serve as the ultimate parity gate. They run
   against the Elixir server exactly as they run against Node today.

### 8.2 Garble harness

The `test/harness/garble-detection.js` harness is the backstop for terminal
output corruption. Port it to ExUnit and keep it running in CI. Any
regression here blocks the merge.

### 8.3 Parity checklist gate

The rewrite branch does not merge until:

- All unit and integration tests (Elixir) pass.
- All Playwright e2e tests (unchanged) pass against the Elixir server.
- Garble harness passes.
- Manual smoke on iPad + desktop against a staged instance (see `bin/katulong-stage`).
- `docs/SECURITY_IMPROVEMENTS.md` checklist re-walked (every hardening
  item in the February 2026 pass is reproduced).

---

## 9. Phases

Even rip-the-bandaid needs internal milestones so progress is legible. All
work happens on `rewrite-elixir-cljs`; nothing ships until Phase 6.

### Phase 0 — Protocol freeze (doc-only, no code)

Output: `docs/protocol/websocket.md`, `docs/protocol/http.md`,
`docs/protocol/session-meta.md`. Exit criterion: the protocol docs are
complete enough that the backend and frontend can be implemented in
parallel.

### Phase 1 — Elixir skeleton

- `mix new` with Phoenix, Bandit, PubSub, Req.
- `Katulong.Application` supervision tree stub.
- `KatulongWeb.Endpoint` serving `priv/static/` and a minimal health route.
- `mix release` builds.
- CI wired (ExUnit + existing Playwright).

Exit: `mix test` passes with zero real tests; `mix release && bin/katulong`
starts and serves the health endpoint.

### Phase 2 — Core backend (sessions + auth + WS)

- Port `tmux-output-parser`, `ring-buffer`, `output-coalescer` as pure
  modules with ExUnit tests.
- Implement `Katulong.Sessions.Session` GenServer wrapping `tmux -C`.
- Implement `KatulongWeb.SessionChannel` with attach/input/resize/output.
- Implement `Auth.Store`, `AuthController`, session cookie middleware,
  localhost bypass (same semantics as `access-method.js`).
- Port persistence GenServers.
- Integration tests via `Phoenix.ChannelTest`.

Exit: a headless script can register a passkey, open a session, send
input, receive output, and all parity integration tests pass.

### Phase 3 — Frontend skeleton (CLJS)

- shadow-cljs project under `assets/`.
- re-frame app-db with session list + one terminal tile renderer.
- JS interop for xterm.js; paste-handler kept as raw JS.
- Login page ported (reuses `@simplewebauthn/browser`).
- Wire to Phoenix endpoint.

Exit: a user can log in, open a terminal tile, type, see output, resize.

### Phase 4 — Feature parity

Grind through the matrix in §7 in difficulty order. Each row gets:

1. Backend port + ExUnit tests
2. Frontend port + app-db events/subs
3. e2e test pass (existing Playwright suite)

Deferred items (WebRTC, plugin loader) are explicitly scoped out unless a
concrete consumer surfaces.

Exit: all entries in §7 are green or explicitly deferred with rationale.

### Phase 5 — Hardening

- Run full security checklist (`docs/SECURITY_IMPROVEMENTS.md`).
- Replay garble harness.
- Stage on a real device (phone, iPad) via `bin/katulong-stage`.
- Soak test (long-lived session, overnight idle, multi-device switching).
- Load test (many sessions, many subscribers per session).

### Phase 6 — Cutover

- One commit: delete `server.js` + `lib/*.js` + `public/*` (except interop
  islands moved to `assets/src/katulong/js/`), update `bin/katulong` to
  invoke `mix release` output, update `package.json` to a stub or remove it,
  update `Formula/katulong.rb`.
- Tag `v1.0.0` (major bump is appropriate).
- Homebrew formula + release notes.

---

## 10. Cutover details

### 10.1 Data migration

Auth state, sessions, shortcuts, config, pub/sub topics, Claude watchlist —
all continue to live at the same filesystem paths with the same JSON shapes.
The Elixir code reads them on boot. A one-shot migration step handles the
session-meta schema change.

### 10.2 CLI surface

Keep `bin/katulong` flags identical: `start`, `stop`, `setup-token`,
`reset`, etc. The wrapper invokes the Elixir release instead of `node
server.js`.

### 10.3 Homebrew

Update `Formula/katulong.rb` to install the Elixir release tarball. The
user-visible install and upgrade paths stay the same.

### 10.4 Rollback

Anyone pinned to the last Node release (`v0.58.x`) keeps working. The
rewrite ships as `v1.0.0`. `brew upgrade katulong` becomes opt-in via
`brew upgrade katulong --force-bottle` or similar — actual mechanism to be
confirmed during Phase 5.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| tmux control-mode parser misses an edge case | Port the parser first as a pure module; run it against recorded tmux output from prod sessions; the garble harness is the backstop |
| re-frame learning curve bleeds into schedule | Pair the first 2–3 events/subs explicitly; `assets/src/katulong/docs/reframe-cheatsheet.md` for the project's conventions |
| Phoenix Channel semantics differ from hand-rolled WS | Write a tiny shim that preserves message names and shapes exactly; the protocol freeze (§4) prevents accidental drift |
| Auth state corruption during migration | First boot of Elixir copies auth files to `~/.katulong/backup-pre-rewrite/` before reading |
| WebRTC users break | We are deferring WebRTC. Audit if anyone relies on DataChannel transport; if yes, keep `node-datachannel` out-of-process and bridge over a socket, or defer the cutover |
| Ollama coordination regresses (one-client invariant) | Single Narrator GenServer — fewer concurrency hazards than the current Node setup, not more |
| Playwright suite drifts during the rewrite | Do not let it drift. Every parity entry in §7 must keep its e2e test green; don't "temporarily skip" anything |
| Cutover PR is unreviewable | The cutover *commit* is one commit, but the branch up to the cutover is the review target. It will be large. Plan for a multi-day review with subagents per subsystem |

---

## 12. What gets deleted at cutover

- `server.js`
- `lib/*.js` (all of it)
- `lib/routes/*.js`
- `public/app.js`
- `public/lib/` (except interop islands relocated to `assets/src/katulong/js/`)
- `public/index.html`, `public/login.html`, `public/login.js`
- `package.json` (replaced with a minimal shell around shadow-cljs, or
  removed if shadow-cljs config lives at `assets/package.json`)
- `nodemon`, `husky` devDependencies

Kept:

- `public/vendor/` assets → `priv/static/vendor/`
- `public/sw.js` → `priv/static/sw.js`
- `public/*.png`, `public/manifest.json`, `public/favicon.ico` →
  `priv/static/`
- `bin/katulong`, `bin/katulong-stage` (updated internals)
- `Formula/katulong.rb` (updated URL + install steps)
- `scripts/restart-dev.sh` (updated to run `iex -S mix phx.server`)
- `docs/` (with new protocol docs from §4 added)
- `test/e2e/` (Playwright — unchanged)

---

## 13. Open questions

These need explicit answers before Phase 1 starts.

1. **Umbrella or flat app?** Flat is simpler; umbrella gives cleaner
   boundaries between `katulong` (core) and `katulong_web`. Recommendation:
   flat, promote to umbrella only if the core module count justifies it.
2. **Headless xterm emulation.** Do we port `@xterm/headless` to a pure
   Elixir terminal emulator, or do we keep a companion Node process just for
   that one component? Recommendation: attempt pure Elixir, with the
   escape hatch of shelling to a small Node helper if we hit walls.
3. **WebRTC.** Kill in v1, or keep a bridge? Recommendation: kill. Nobody
   on the memory-tracked team has a DataChannel dependency.
4. **Plugin loader.** Is there a real plugin in use today, or is this
   dead weight? Recommendation: check, kill if unused.
5. **Database.** Stay on JSON files, or introduce SQLite via Ecto?
   Recommendation: JSON files for v1, SQLite only if a query need emerges
   (the Claude feed watchlist might be the first candidate).
6. **Release target OSs.** Currently Node means Mac + Linux trivially.
   Elixir releases must be built per-platform. Recommendation: macOS
   (arm64 + x86_64) + Linux x86_64 at launch; add others on demand.
7. **Minimum Elixir/OTP.** Pin Elixir 1.16 + OTP 26 (both stable, both on
   Homebrew).
8. **Repo layout.** Does `assets/` live at repo root or inside
   `priv/`? Recommendation: repo root (Phoenix convention since 1.7).

---

## 14. What this plan deliberately does not do

- Introduce TypeScript as a stepping stone. Either stay JS or move to CLJS;
  don't thrash twice.
- Rewrite for scaling beyond one host. Katulong is still self-hosted,
  single-user. No multi-tenancy, no distributed Erlang, no cluster.
- Pluggable anything — per the memory note on premature generalization.
  Stay Katulong-specific until a second concrete consumer exists.
- Add new features during the rewrite. Parity first, features after.

---

## References

- `CLAUDE.md` — security model, testing rules, worktree-first workflow
- `docs/clipboard-bridge.md` — why `paste-handler.js` stays raw JS
- `docs/terminal-sizing.md` — one-PTY-one-size constraint
- `docs/SECURITY_IMPROVEMENTS.md` — February 2026 hardening checklist
- `docs/terminal-data-pipeline.md` — current output path to port
- Memory: `feedback_no_premature_generalization.md`,
  `feedback_worktree_strict.md`, `project_ollama_model.md`
