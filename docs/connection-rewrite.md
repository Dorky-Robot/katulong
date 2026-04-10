# Connection Rewrite — Transport-Agnostic Lifecycle

## The problem we're solving

The transport layer is clean: `transport.send()` routes data to
WebSocket or DataChannel atomically, call sites don't care. But
everything above it — liveness detection, reconnection, status
indicator — reaches past the abstraction and grabs the raw WebSocket:

- **`websocket-connection.js` creates a raw WS and hooks its events
  directly.** `ws.onopen` drives "connected," `ws.onclose` drives
  "disconnected" and triggers reconnect. If DataChannel is active and
  the connection dies, the transport auto-downgrades to WS — but
  nobody checks if that WS is actually alive. The connection manager
  doesn't go through the transport; it goes around it.

- **No client-side heartbeat.** The server pings over WS protocol
  frames every 30s (`ws.ping()` in ws-manager.js:283). But: (a) WS
  protocol pings are invisible to JavaScript — the browser handles
  them silently, the client can't observe them. (b) The ping uses
  the raw WebSocket, not the transport. When DC is active, the WS
  is a signaling channel only — a successful WS pong says nothing
  about whether the data path is alive. (c) If the network drops,
  TCP may never deliver the server's terminate — the client sits
  with a half-open socket and a green dot forever.

- **`network-monitor.js` is vestigial.** Listens for `online` but
  not `offline`. The callback in app.js is a no-op comment. Going
  offline doesn't update the indicator or close the transport.

- **Connection state is scattered.** Four sources of truth:
  1. `connectionState` — local variable inside websocket-connection.js
     (not observable)
  2. `state.connection.attached` — plain property on app state
  3. `state.connection.transportType` — plain property on app state
  4. `ws.readyState` / `dc.readyState` — actual transport state

  These can desync. `updateConnectionIndicator()` must be manually
  called at every transition point — miss one and the dot lies.

- **The file is called `websocket-connection.js`.** The name tells
  you where the abstraction leaks.

The result: the connection dot shows green when you're disconnected.
You have to manually refresh to reconnect. The transport layer solved
the data path but the lifecycle is still WS-coupled.

## First principles

1. **The transport is the connection.** Connection liveness means "can
   I send data and get a response." That's a property of the transport,
   not of the underlying WebSocket. Heartbeat, reconnection, and status
   all work through `transport.send()` / `transport.onmessage`.

2. **One state atom for connection.** A `createStore` instance (same
   pattern as `ui-store.js`) tracks status and transport type. The
   indicator subscribes reactively. No manual
   `updateConnectionIndicator()` calls scattered across 6 sites.

3. **Pure state machines, composed at the edge.** The heartbeat is a
   pure state machine (like `pull-manager.js`) with zero knowledge of
   transports, timers, or DOM. The connection manager is the imperative
   shell that wires the clock and the transport. Same pattern that
   made pull-manager testable with 17 pure tests and no mocking.

4. **Heartbeat is app-level, not protocol-level.** Send `{ type:
   "ping" }` through `transport.send()`, expect `{ type: "pong" }`
   back. Works over WS or DC identically. The server-side WS
   protocol ping (`ws.ping()`) stays for TCP keepalive — it
   complements the app-level heartbeat, doesn't replace it.

5. **Detect death fast, reconnect fast.** Offline event = immediate.
   Heartbeat timeout = 10s. Visibility return after backgrounding =
   immediate probe. The user should never see a stale indicator for
   more than one heartbeat interval.

6. **No raw socket references leak.** The connection manager exposes
   `send(msg)`, not `getTransport()` or `getWebSocket()`. Consumers
   (input-sender, pull-manager callbacks) receive a send function.
   Nobody outside the connection manager touches a raw WebSocket.

7. **Epoch counter prevents stale callbacks.** Every `connect()` call
   increments a monotonic epoch. Heartbeat timeouts, reconnect timers,
   and onclose handlers check `if (epoch !== myEpoch) return`. This
   is the same pattern as `_writeId` in pull-manager.js — proven by
   the forceReconnect race at `866038d`.

## The state shape

```js
// connection-store state (not persisted — ephemeral)
{
  status: "disconnected",  // disconnected | connecting | ready
  transport: null,         // null | "websocket" | "datachannel"
}
```

Two fields. No `reconnectDelay` (internal to the connection manager),
no `ws` reference (internal to the transport), no `attached` boolean
(derived: `status === "ready"`).

### Naming: "ready" not "attached"

The old code used "attached" for both the connection state and the
session concept (the server's `attach` message means "you are now
bound to tmux session X"). Reusing the same word across two bounded
contexts causes confusion: "attached to what?"

In the connection domain, the concept is **ready** — the transport
can carry data and has proven it with a heartbeat. The session domain
keeps its "attach" vocabulary unchanged.

### Invariants (enforced by the reducer)

1. `status === "disconnected"` ⟹ `transport === null`
2. `status === "ready"` ⟹ `transport` is `"websocket"` or
   `"datachannel"` (never null)
3. Valid transitions:
   ```
   disconnected → connecting    (CONNECTING)
   connecting   → ready         (READY)
   connecting   → disconnected  (DISCONNECTED)
   ready        → ready         (TRANSPORT_CHANGED — self-loop)
   ready        → disconnected  (DISCONNECTED)
   ```
   Any other transition is rejected by the reducer (returns current
   state unchanged). This prevents impossible states like going from
   `disconnected` directly to `ready`.

```
disconnected → connecting → ready
     ↑              |          |
     └──────────────┴──────────┘  (any failure)
                               ↺  TRANSPORT_CHANGED (self-loop)
```

### Why no "connected" state

The old state machine had four states: DISCONNECTED → CONNECTING →
CONNECTED → ATTACHED. The CONNECTED → ATTACHED gap exists because
the WS opens before the server confirms the attach message. From the
user's perspective this is still "connecting" — the dot shouldn't
change until data can flow. So we collapse CONNECTED into CONNECTING.

### Why no persistence

Connection state is inherently ephemeral. On page load you're always
disconnected. Unlike tile state, there's nothing to restore.

## Actions

```
CONNECTING        { }                    // transport being established
READY             { transport: string }  // server confirmed, data flowing
TRANSPORT_CHANGED { transport: string }  // DC upgrade or WS fallback
DISCONNECTED      { }                    // transport dead
```

Four actions. The indicator derives from `status` + `transport`:

| status       | transport      | dot        | overlay     |
|-------------|---------------|------------|-------------|
| disconnected | null          | grey       | visible     |
| connecting   | null          | pulsing    | hidden      |
| ready        | "websocket"   | yellow     | hidden      |
| ready        | "datachannel" | green      | hidden      |

The "pulsing" state is new — currently disconnected and connecting
look the same (grey dot, overlay visible). Pulsing tells the user
"I know I'm disconnected and I'm working on it."

## Heartbeat machine — pure state machine

The heartbeat is extracted as a pure state machine identical in
spirit to `pull-manager.js`: zero knowledge of transports, timers,
or DOM. Communicates via return values, not side effects.

```js
// heartbeat-machine.js — pure, no imports, no side effects

const IDLE = "idle";
const WAITING = "waiting";

function create({ intervalMs = 10000, timeoutMs = 8000 } = {}) {
  return { status: IDLE, sentAt: 0, epoch: 0 };
}

function reset(state, epoch) {
  return { ...state, status: IDLE, sentAt: 0, epoch };
}

function sendPing(state, now) {
  if (state.status !== IDLE) return { state, effects: [] };
  return {
    state: { ...state, status: WAITING, sentAt: now },
    effects: [{ type: "sendPing" }],
  };
}

function receivePong(state, epoch) {
  // Stale pong from a previous connection — ignore
  if (epoch !== state.epoch) return { state, effects: [] };
  if (state.status !== WAITING) return { state, effects: [] };
  return {
    state: { ...state, status: IDLE, sentAt: 0 },
    effects: [],
  };
}

function tick(state, now, { timeoutMs }) {
  if (state.status !== WAITING) return { state, effects: [] };
  if (now - state.sentAt < timeoutMs) return { state, effects: [] };
  return {
    state: { ...state, status: IDLE, sentAt: 0 },
    effects: [{ type: "timeout" }],
  };
}
```

**Why a separate machine, not baked into the connection manager:**

- **Testable with zero mocks.** `tick(state, now + 9000, opts)` →
  no effect. `tick(state, now + 11000, opts)` → timeout. No timers,
  no transports, no DOM in the test.
- **Composable.** The connection manager drives the clock
  (`setInterval` calls `tick()`) and wires the effects (`sendPing`
  → `transport.send()`, `timeout` → close transport). The heartbeat
  machine doesn't know any of this.
- **Epoch-aware.** The epoch counter prevents the `866038d` race:
  a pong from a previous connection attempt is silently ignored
  because its epoch doesn't match.

## App-level heartbeat protocol

```
Client                          Server
  │                               │
  ├── { type: "ping" } ─────────►│
  │                               ├── { type: "pong" }
  │◄──────────────────────────────┤
  │                               │
  │  (10s interval)               │
```

- Sent through `transport.send()` — goes over WS or DC, whatever
  is active.
- Server responds with `{ type: "pong" }` through the same
  transport. Trivial handler in ws-manager.js.
- The connection manager drives the heartbeat machine with a 10s
  interval timer. On each tick, it calls `sendPing(state, now)` and
  `tick(state, now, opts)`, executing any returned effects.
- The heartbeat timer runs only when `status === "ready"`. Pauses
  during connecting/disconnected (no point pinging a dead transport).
- The heartbeat response is the ground truth for "am I alive" — not
  the WS readyState, not a boolean flag, not the browser's idea of
  socket state.

### Worst-case stale window

Ping fires every 10s. Timeout is 8s. Worst case: ping fires at t=0,
network dies at t=0.001s, timeout at t=8s, reconnect begins at t=8s.
The user sees a stale indicator for at most **8 seconds**. The
`offline` event (when available) reduces this to near-instant.

### Why app-level, not WS protocol ping

- **Transport-agnostic.** WS protocol pings don't exist for
  DataChannel. App-level ping works over both.
- **Observable.** Browser JavaScript cannot see WS protocol
  ping/pong frames. The app-level pong arrives as a message the
  client can act on.
- **End-to-end.** A WS protocol pong proves the TCP connection is
  alive. An app-level pong proves the server's message handler is
  alive and the full transport stack (including DC relay if
  applicable) works.

### Server-side WS ping stays

The existing `ws.ping()` in ws-manager.js (30s interval, 2 missed
pongs = terminate) stays. It serves a different purpose: TCP
keepalive and server-side dead-client cleanup. The app-level
heartbeat is client → server; the WS ping is server → client. Both
are needed.

## Network monitoring — inlined, not a module

The current `network-monitor.js` is 51 lines wrapping two
`addEventListener` calls, with a callback in app.js that's a no-op.
This doesn't earn its keep as a separate module.

Network events are inlined into the connection manager's `init()`:

```js
window.addEventListener("offline", () => {
  // Immediately close transport, dispatch DISCONNECTED
  this.disconnect();
});
window.addEventListener("online", () => {
  // Reset backoff, reconnect immediately
  this.reconnectNow();
});
```

`network-monitor.js` is deleted.

## Connection manager — imperative shell

`public/lib/connection-manager.js` replaces `websocket-connection.js`.
It is the imperative shell: it owns timers, the transport reference,
and browser event listeners. It composes the pure pieces (heartbeat
machine, connection store) and wires them to the impure world.

```
connection-manager.js  (imperative shell)
    ├── creates transport (WS + optional DC upgrade)
    ├── drives heartbeat-machine with a clock
    ├── dispatches to connection-store on state changes
    ├── reconnects with exponential backoff on failure
    ├── listens for offline/online/visibilitychange
    └── exposes send(msg), onMessage callback, subscribe()

heartbeat-machine.js  (pure core)
    ├── state: { status, sentAt, epoch }
    ├── transitions: sendPing, receivePong, tick, reset
    └── returns { state, effects } — zero side effects

connection-store.js  (pure core)
    ├── state: { status, transport }
    ├── reducer with enforced invariants
    └── subscribers (indicator, overlay, input gating)

transport-layer.js  (unchanged)
    ├── atomic WS ↔ DC switching
    ├── unified send/receive API
    └── signaling always over WS
```

### API surface

```js
const cm = createConnectionManager({
  getSessionName,      // () => string — only slice of app state needed
  onMessage,           // (msg) => void — parsed message callback
});

cm.connect();          // start connection + heartbeat
cm.disconnect();       // tear down, stop reconnecting
cm.reconnectNow();     // reset backoff, connect immediately
cm.send(msg);          // send through transport (JSON-stringified)
cm.subscribe(fn);      // delegates to connection-store.subscribe
cm.init();             // wire offline/online/visibilitychange
```

The connection manager does NOT receive the mutable `state` object.
It receives `getSessionName` — a function that returns the one value
it needs. This prevents anyone from reaching into `state.connection`
because `state.connection` no longer exists.

### Epoch counter

Every `connect()` call increments a monotonic `epoch`. The epoch is
passed to the heartbeat machine (`reset(state, epoch)`) and checked
in every timer callback:

```js
function connect() {
  epoch++;
  const myEpoch = epoch;

  // ... create transport ...

  ws.onclose = () => {
    if (myEpoch !== epoch) return; // stale — already reconnected
    // ... handle close ...
  };
}
```

This eliminates the `866038d` race where a stale `onclose` handler
fired on an already-replaced connection. Same pattern as `_writeId`
in pull-manager.js.

### Reconnection strategy

```js
const BACKOFF_INITIAL = 1000;    // 1s
const BACKOFF_MAX     = 10000;   // 10s
const BACKOFF_FACTOR  = 2;

// On disconnect:
// 1. dispatch DISCONNECTED
// 2. schedule reconnect after backoffDelay
// 3. double backoffDelay (capped at BACKOFF_MAX)

// On successful ready:
// 1. reset backoffDelay to BACKOFF_INITIAL

// On online event:
// 1. reset backoffDelay to BACKOFF_INITIAL
// 2. reconnect immediately (cancel pending timer)
```

Same exponential backoff as today, but driven from transport failure
instead of `ws.onclose`. The "online" event fast-paths back to
immediate retry instead of waiting out the backoff.

### Crash-restart wrapper

Every timer callback and `transport.onmessage` handler is wrapped
in a try/catch. On any unexpected error, the connection manager
tears down the entire connection and restarts from scratch:

```js
function safeCallback(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error("[connection] Unexpected error, restarting:", err);
      teardownAndReconnect();
    }
  };
}
```

This is the supervisor. An exception in the heartbeat timer or
message handler doesn't leave the connection in a half-alive state
with a stale indicator — it crashes and restarts cleanly.

### Visibility change

Same logic as today: if backgrounded for > 5s, close the transport
on return (forces a fresh attach with full state). If < 5s, send an
immediate heartbeat probe — if the pong comes back, we're fine; if
not, the heartbeat timeout triggers reconnect.

## Message handlers — pure map, effect executor in app.js

The 30+ message handlers (`attached`, `switched`, `output`,
`session-renamed`, `helm-mode-changed`, etc.) are already pure
functions that return `{ stateUpdates, effects }`. They stay as a
handler map — the connection manager passes parsed messages to it.

Key change: **handlers receive a narrow context, not the whole
mutable `state` object.** Currently `handler(msg, state)` where
`state` is the full app state with `.update()` methods. Instead:

```js
handler(msg, { currentSessionName })
// → { stateUpdates, effects }
```

The context is a plain value object with only the slice the handler
needs. This makes handlers referentially transparent — same message
+ same context → same output. Testable with literal objects.

**The effect executor stays in app.js** — it is the composition
root. The handler map returns effect descriptors; app.js has the
17 callbacks (`invalidateSessions`, `poolRename`, `onHelmEvent`,
etc.) and executes effects. This is the existing pattern formalized:
handlers never import or know about the effect handlers.

**Effect types are a closed set.** All effect types are exported
constants (like ui-store's action types). The executor has a default
case that throws in development:

```js
if (!effectHandlers[effect.type]) {
  throw new Error(`Unknown effect: ${effect.type}`);
}
```

Whether the handler map lives in its own file (`message-handlers.js`)
or stays collocated with the connection manager is a team preference
call. The handlers are already structurally separated (pure map vs.
imperative lifecycle) — file boundaries are secondary.

## What changes on the server

Minimal:

1. **Handle `ping` messages in ws-manager.js** — respond with
   `{ type: "pong" }`. Three lines:
   ```js
   if (msg.type === "ping") {
     transport.send(JSON.stringify({ type: "pong" }));
     return;
   }
   ```

2. **Keep the existing WS protocol ping** — no changes needed.
   It stays for TCP keepalive and server-side dead-client reaping.

That's it. The server already sends `server-draining` on graceful
shutdown (websocket-connection.js:241-247), which the client handles
with a fast reconnect. No additional server changes needed.

## What changes in the indicator

CSS gains a `connecting` state with a pulse animation:

```css
#connection-indicator.connecting {
  background: var(--text-dim);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}
```

The indicator subscribes to `connection-store`:

```js
connectionStore.subscribe(({ status, transport }) => {
  const cssClass =
    status === "ready" && transport === "datachannel" ? "direct" :
    status === "ready" ? "relay" :
    status === "connecting" ? "connecting" :
    "";  // disconnected = default grey

  for (const dot of dots) {
    dot.classList.remove("connected", "relay", "direct", "connecting");
    if (cssClass) dot.classList.add(cssClass);
  }
  overlay.classList.toggle("visible", status === "disconnected");
});
```

No more `updateConnectionIndicator()` function passed as a dep to
17 different callbacks. The store subscription is the single place.

## What changes in input-sender

`input-sender.js` currently reaches past the transport abstraction
with a two-tier fallback (`getTransport()` then `getWebSocket()`).
After the rewrite, it receives a single `send` function from the
connection manager:

```js
const inputSender = createInputSender({
  send: (data) => connectionManager.send(data),
  getSession: () => sessionName,
  onInput,
});
```

No `getWebSocket`, no `getTransport`, no `readyState` checks. If
the connection isn't ready, `connectionManager.send()` is a no-op
(the manager checks its own store status). The input gating
(`state.connection.attached` guard) moves into the manager.

## Build order

### Tier 1: Pure core (testable state machines)

1. **`connection-store.js`** — reducer, actions, subscribe. Frozen
   `EMPTY_STATE`. Reducer enforces invariants: rejects impossible
   transitions, nulls transport on disconnect, requires transport
   on ready. **Tests first** (TDD): all transitions, impossible
   states rejected, invariants hold.

2. **`heartbeat-machine.js`** — pure state machine with zero
   imports. State: `{ status, sentAt, epoch }`. Functions:
   `create()`, `reset()`, `sendPing()`, `receivePong()`, `tick()`.
   Returns `{ state, effects }`. **Tests first**: 10-15 pure tests.
   `tick` past timeout → timeout effect. `receivePong` with wrong
   epoch → no-op. No mocking needed.

### Tier 2: Imperative shell + server

3. **`connection-manager.js`** — creates transport, drives heartbeat
   machine with a clock, manages reconnect with backoff, dispatches
   to connection-store. Epoch counter. Crash-restart wrapper.
   Offline/online/visibility handlers inlined. Exposes `send()`,
   `subscribe()`, `onMessage` callback. Does NOT receive the mutable
   `state` object — only `getSessionName`.

4. **Server: add `ping` → `pong` handler** in ws-manager.js.

### Tier 3: Rewire app.js

5. **Narrow message handler context** — change handlers from
   `handler(msg, state)` to `handler(msg, { currentSessionName })`.
   Effect types become exported constants (closed set). Effect
   executor in app.js gets a default throw for unknown types.

6. **Rewire app.js boot** — replace `createWebSocketConnection`
   with `createConnectionManager`. Indicator subscribes to
   connection-store. input-sender receives `cm.send`. Delete
   `state.connection.*` from app state. Delete
   `updateConnectionIndicator()`.

### Tier 4: Cleanup + CSS

7. **Delete** `websocket-connection.js`, `network-monitor.js`,
   `connection-indicator.js` (indicator logic moves into the store
   subscriber), the no-op callback, the `.connected` CSS class.

8. **CSS: add `.connecting` pulse** to all three dot selectors.
   Disconnect overlay shows "Reconnecting..." when `status ===
   "connecting"`.

## What gets deleted

- `websocket-connection.js` (subsumed by connection-manager +
  handler map)
- `network-monitor.js` (inlined into connection-manager)
- `connection-indicator.js` (indicator logic in store subscriber)
- `state.connection.*` on app state (subsumed by connection-store)
- `updateConnectionIndicator()` function in app.js
- Manual `deps.updateConnectionIndicator?.()` calls (6 sites)
- The `"connected"` CSS class (unused — was never applied by code)
- The no-op `onNetworkChange` callback

## What stays as-is

- `transport-layer.js` — client-side transport abstraction.
  Unchanged. The connection manager creates and uses it.
- `webrtc-peer.js` — DataChannel negotiation. Unchanged.
- `client-transport.js` — server-side transport abstraction.
  Unchanged.
- `webrtc-signaling.js` — server-side WebRTC handler. Unchanged.
- Server-side WS protocol ping in ws-manager.js. Stays for TCP
  keepalive.
- All 30+ message handlers — same logic, same effect system.
  The only change is the context parameter narrows from `state`
  to a plain value slice.
- The effect handler table — same dispatch mechanism, stays in
  app.js.
- `pull-manager.js` — its `onSendPull` callback will receive a
  `send` function from the connection manager instead of reaching
  for `state.connection.ws`.

## Test plan

### Unit tests (pure, no mocking)

- **`connection-store.test.js`** — reducer transitions: CONNECTING,
  READY, TRANSPORT_CHANGED, DISCONNECTED. Impossible transitions
  rejected (disconnected → ready). Invariants enforced (transport
  null when disconnected). Subscribe/notify on state change.

- **`heartbeat-machine.test.js`** — sendPing returns sendPing
  effect. tick before timeout → no effect. tick after timeout →
  timeout effect. receivePong clears waiting. receivePong with wrong
  epoch → no-op. reset clears state. Double sendPing is idempotent.
  10-15 tests, zero mocking.

### Integration tests

- **`connection-manager.test.js`** — requires mock WebSocket and
  timer injection. Heartbeat timeout triggers disconnect + reconnect.
  Backoff doubles on failure, resets on success. Epoch counter
  prevents stale callback execution. Crash-restart wrapper catches
  thrown errors.

### Manual test matrix

- Disconnect server → dot goes grey within 8-10s, overlay shows,
  reconnects when server restarts.
- Airplane mode on phone → dot goes grey immediately (offline
  event), pulsing "Reconnecting..." overlay. Airplane off → connects
  within 1-2s.
- Switch WiFi networks → brief grey/pulse, reconnects on new
  network.
- DC active (green dot) → kill server → dot goes grey within 10s.
  (Previously: stayed green forever.)
- Background tab for 30s → return → immediate heartbeat probe,
  reconnects if stale.
- Fresh page load → grey → pulsing → yellow (WS) → green (DC
  upgrade). Each state visible briefly.
- Server graceful restart (`katulong restart`) → client receives
  `server-draining`, reconnects with 500ms backoff.

## Out of scope

- Changing the transport layer internals (WS ↔ DC switching).
- Changing the WebRTC negotiation flow.
- Changing server-side WS protocol ping/pong.
- Changing message handler logic (what happens when you receive
  `output`, `attached`, `session-renamed`, etc.).
- Adding new transport types (QUIC, etc.).
- Persisting connection state.

## Consultation notes

This design was reviewed by 8 agents channeling Rich Hickey, Alan
Kay, Eric Evans, FP tradition, Joe Armstrong, Sandi Metz, Leslie
Lamport, and Kent Beck. Key refinements from that review:

- **Heartbeat extracted as pure state machine** (Hickey, Kay, FP)
  — pull-manager proved the pattern; heartbeat follows it.
- **Epoch counter** (Armstrong, Lamport) — prevents the 866038d
  stale-callback race. Already proven by `_writeId` in pull-manager.
- **Reducer enforces invariants** (FP, Lamport) — impossible states
  are rejected, not hoped away.
- **"ready" not "attached"** (Evans) — avoids collision with
  session domain vocabulary.
- **No raw socket leaks** (Hickey, Kay) — connection manager exposes
  `send()`, input-sender receives a function.
- **Effect executor stays in app.js** (Kay, FP, Metz) — handlers
  return pure data, composition root executes effects.
- **Network monitor inlined** (Hickey, FP) — two `addEventListener`
  calls don't justify a module.
- **Crash-restart wrapper** (Armstrong) — timer/handler errors
  tear down and restart cleanly.

## Rollback plan

The current `websocket-connection.js` is the last working state. If
the rewrite regresses something, the file still exists in git history.
The message handlers are moved, not rewritten, so reverting is a
matter of re-combining connection-manager + handler map back into the
original file shape.
