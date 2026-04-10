# Terminal Data Pipeline

How terminal bytes flow from tmux to the browser in katulong, and why
each layer exists. This is the canonical reference for anyone touching
the terminal rendering path.

## The Pipeline at a Glance

```
tmux -u -C attach-session -d -t <name>
  │  raw stdout bytes (Buffer chunks, split anywhere)
  ▼
tmux-output-parser.js          ← byte-level, no string conversion
  │  decoded UTF-8 strings
  ▼
session.js
  ├─→ RingBuffer (bounded circular buffer, 20 MB)
  ├─→ ScreenState (headless xterm.js mirror for snapshots)
  └─→ output-coalescer.js (2 ms idle + 16 ms hard-cap)
        │  coalesced flush
        ▼
      session-manager.js → transport-bridge.js
        │  { type: "output", data, fromSeq, cursor }
        ▼
      ws-manager.js
        ├─ push inline (fast path, zero round trips)
        └─ data-available (backpressure, client pulls later)
              │
              ▼
        Browser: pull-manager.js → terminal-pool.js → xterm.js
```

## Layer 1: tmux Control Mode

**File:** `lib/session.js`

tmux is spawned in UTF-8 control mode:

```
tmux -u -C attach-session -d -t <session-name>
```

- **`-u`**: UTF-8 mode. Tells tmux to emit high bytes (0x80+) literally
  instead of always octal-escaping them. Without this flag, every
  non-ASCII byte becomes `\NNN`, tripling wire size for UTF-8 text.
- **`-C`**: Control mode. tmux wraps all output in a line-based protocol:
  `%output %<pane_id> <escaped-payload>\n`. Everything else (`%begin`,
  `%end`, `%session-changed`) is framing noise we discard.
- **`-d`**: Detach other clients. We're the sole control-mode consumer.

Raw `stdout` chunks (Buffers) are piped directly to the parser:
```js
proc.stdout.on("data", (chunk) => this._parser.write(chunk));
```

### The Splitting Problem

tmux wraps `%output` lines at a fixed byte limit with no regard for
encoding boundaries. A 3-byte character like `─` (e2 94 80) can end
up split across two lines:

```
%output %0 hello\342          ← line ends with lead byte e2
%output %0 \224\200world      ← continuation bytes 94 80 on next line
```

This is not a bug in tmux. It is the fundamental constraint the parser
must handle.

## Layer 2: Byte-Level Parser

**File:** `lib/tmux-output-parser.js`

This is the most critical module for rendering correctness. It operates
entirely in byte space (Buffers) until the very last step.

### Why Byte-Level?

If you run a `StringDecoder` over raw tmux stdout, orphaned lead bytes
(like `e2` at the end of a chunk) emit U+FFFD *before you ever see the
payload layer*. The damage is done before parsing begins. Every approach
that converts to strings early is fundamentally broken for non-ASCII.

### Three Pieces of State

1. **`lineBuf`** — Buffer of partial line bytes. Node chunks can split
   mid-line (rare but possible).

2. **`payloadDecoder`** — A single persistent `StringDecoder("utf-8")`.
   This is the ONE AND ONLY place byte-to-string conversion happens.
   It correctly carries partial multi-byte characters across calls.

3. **`octalCarry`** — Buffer of 1-3 bytes from a partial `\NNN` octal
   escape deferred from the previous `%output` line.

### Processing Steps

For each complete line (delimited by `\n`):

1. **Prefix match** — Does it start with `%output ` (ASCII bytes)?
   If not, skip (framing noise).

2. **Pane ID extraction** — Find the space after `%<pane_id>` to locate
   the payload start.

3. **Octal unescape** — `unescapeOutputBytes(buf, octalCarry)` converts
   `\NNN` sequences back to raw bytes. Stays in Buffer space throughout.
   Returns `{ bytes, carry }` where `carry` holds any incomplete escape.

4. **UTF-8 decode** — `payloadDecoder.write(rawBytes)` converts the
   clean bytes to a JS string. The decoder buffers incomplete multi-byte
   sequences internally and completes them on the next call.

5. **Emit** — `onData(decodedString)` fires once per decoded `%output`
   line.

### The Octal Carry

tmux escapes bytes `< 0x20` and `\` as `\NNN` (3-digit octal). Each
`█` character (e2 96 88) becomes `\342\226\210` — 12 wire bytes. A
banner of 26 blocks is 312 bytes, easily exceeding tmux's wrap limit.
When the wrap falls inside an escape:

```
%output %0 ...\34            ← partial escape: only \34 of \342
%output %0 2\226\210...      ← remaining digits on next line
```

The parser defers the `\34` as `octalCarry` and prepends it to the next
line's payload before unescaping. Without this, the parser desyncs and
every subsequent escape on the line produces U+FFFD.

## Layer 3: Session and RingBuffer

**File:** `lib/session.js`, `lib/ring-buffer.js`, `lib/screen-state.js`

When the parser emits a decoded string:

```js
_handleOutputPayload(payload) {
  this.outputBuffer.push(payload);   // RingBuffer
  this._screen.write(payload);       // headless xterm.js
  this._onData(this.name, fromSeq);  // notify coalescer
}
```

### RingBuffer

Bounded circular buffer (20 MB per session). Stores raw decoded strings
including escape sequences. Clients pull byte ranges via `sliceFrom(offset)`.
When a client's cursor is evicted (ring has wrapped past it), the server
sends a full snapshot instead.

Key property: `totalBytes` is monotonic — it never decreases, even after
eviction. This gives every byte a unique position in the stream, like a
Kafka offset.

### ScreenState (Headless xterm.js)

A server-side `@xterm/headless` Terminal + SerializeAddon. Mirrors the
live terminal state so `serialize()` can produce a snapshot for:
- Client attach (new connection gets current screen)
- Client resync (drift detected, send fresh snapshot)
- Cursor eviction recovery (ring wrapped, full reset)

The headless is written live at the current PTY dimensions and resized
in lockstep with tmux. There is ONE shared headless per session.

**Why not per-client headless?** Per-client headless terminals (PCH-1
through PCH-3) were tried extensively. They solved multi-device viewport
mismatch but introduced worse problems: TUI apps use absolute cursor
positioning (`\e[row;colH`) calculated for tmux's current size, so
replaying the RingBuffer into a differently-sized headless lands those
escapes on wrong cells. PCH-7 deleted `ClientHeadless`. See "What Was
Tried and Failed" below.

## Layer 4: Output Coalescer

**File:** `lib/output-coalescer.js`

TUI apps like htop render a full frame across many `%output` lines
delivered over multiple Node.js I/O ticks. Without coalescing, each
line becomes a separate WebSocket message, breaking xterm.js synchronized
rendering and causing visible tearing.

### Dual-Timer Strategy

- **2 ms idle timer**: Resets on each new `%output`. Fires when output
  stops (inter-frame gap). Captures complete TUI frames.
- **16 ms hard cap**: Fires regardless of activity. Guarantees ~60fps
  delivery for continuous streams (tail -f, cargo build). Without this,
  the idle timer would starve clients indefinitely.

On flush, the session manager pulls `RingBuffer.sliceFrom(fromSeq)` and
relays the coalesced chunk to all subscribed clients.

## Layer 5: WebSocket Transport

**File:** `lib/ws-manager.js`, `lib/transport-bridge.js`

### Push vs Pull

The server tries to **push** output inline (zero round trips):

```js
transport.send(JSON.stringify({ type: "output", data, fromSeq, cursor }));
```

When the WebSocket's `bufferedAmount` exceeds 1 MB (backpressure), it
falls back to a lightweight notification:

```js
transport.send(JSON.stringify({ type: "data-available", session }));
```

The client then explicitly **pulls** data at its own pace.

### Client Lifecycle Messages

| Message | Direction | Purpose |
|---------|-----------|---------|
| `attach` | client→server | Join session, get initial snapshot |
| `attached` | server→client | Snapshot + session name |
| `subscribe` | client→server | Watch session without being active |
| `seq-init` | server→client | Initialize client's cursor position |
| `output` | server→client | Pushed terminal data (fast path) |
| `data-available` | server→client | Backpressure notification |
| `pull` | client→server | Request data from cursor |
| `pull-response` | server→client | Requested data + new cursor |
| `pull-snapshot` | server→client | Full reset (cursor evicted) |
| `resize` | client→server | Terminal dimensions changed |

## Layer 6: Client-Side Pull Manager

**File:** `public/lib/pull-manager.js`

Pure state machine per session. Tracks:
- **cursor**: byte offset into the server's stream
- **pulling**: waiting for a pull-response
- **writing**: waiting for xterm.js to finish rendering
- **pending**: more data arrived while busy

Key invariant: the next pull only fires **after xterm.js finishes
rendering the current write**. This provides natural backpressure without
explicit flow control. The server never overwhelms the client because the
client controls its own consumption rate.

### Gap Detection

When the server pushes `{ fromSeq: 1000 }` but the client's cursor is
at 800, there's a gap (bytes 800-999 were missed). The pull manager
detects this and falls back to an explicit pull request to fill the gap.

## Layer 7: Browser Rendering

**File:** `public/lib/terminal-pool.js`

One xterm.js `Terminal` instance per session, managed in a pool. The
active session's container is visible; others are hidden but alive (no
re-initialization on switch).

```js
term.write(data);  // xterm.js handles escape sequences, reflow, rendering
```

### Resize Flow

```
Browser viewport change
  → terminal-pool.js: scaleToFit() calculates cols/rows from container
  → 80ms debounce (rapid events coalesce)
  → WebSocket: { type: "resize", cols, rows }
  → ws-manager.js → session-manager.js
  → session.js: resize gate (defer if output arrived < 50ms ago)
  → tmux: refresh-client -C <cols>x<rows>
  → ScreenState.resize(cols, rows)
```

The resize gate prevents SIGWINCH storms during rapid resize (e.g.,
window drag). Without it, TUI apps receive a barrage of dimension
changes mid-render, producing garbled output.

## What Was Tried and Failed

This section exists so future developers don't repeat these dead ends.

### 1. StringDecoder on Raw Stdout (pre-v0.52.5)

**Approach:** `proc.stdout.on('data', chunk => decoder.write(chunk))`

**Why it failed:** tmux splits `%output` lines at byte boundaries. An
orphaned lead byte (e.g., `e2` at end of chunk) reaches the decoder
*before* the parser extracts the payload, emitting U+FFFD at the wrong
layer. Corruption happens before parsing even begins.

**Symptom:** Bursts of diamond question marks (U+FFFD) replacing
box-drawing characters, stacked spinners, garbled TUI after any
non-ASCII output.

### 2. Latin1 String Round-Trip (v0.52.5-alpha)

**Approach:** Convert the `%output` payload to a latin1 string
(`buf.toString("latin1")`), then unescape octal sequences as string
operations.

**Why it failed:** Literal byte `0xe2` (lead byte of `─`) becomes
U+00E2 in latin1, which re-encodes to UTF-8 as `c3 a2` — a
double-encoding that turns every non-ASCII byte into a 2-byte mojibake
sequence.

**Symptom:** Box-drawing characters and Unicode text replaced with
accented Latin characters (`â`, `ã`, etc.).

### 3. Per-Client Headless Terminals (PCH-1 through PCH-6)

**Approach:** Give each connected client its own server-side headless
xterm.js instance at that client's dimensions. Replay the shared
RingBuffer into each headless independently. Serialize per-client
snapshots for attach/resync/drift-detection.

**Why it failed:** TUI applications use absolute cursor positioning
(`\e[row;colH`) calculated for tmux's current PTY dimensions. When
those escape sequences are replayed into a headless terminal at
*different* dimensions, cursors land on wrong cells, status bars float
in the middle of the screen, and borders misalign. The per-client
headless doesn't reflow the content — it just renders it wrong.

**Additional problems:**
- Lazy replay was O(N) per serialize, causing lag
- Dispose races between disconnect and serialize
- Dimension changes on carousel swipe kept stale headless sizes
- Drift detection fingerprints differed across clients, causing
  resync storms

**Resolution:** PCH-7 deleted `ClientHeadless`. All serialization now
uses the shared `session._headless`, which is written live at current
PTY dimensions and resized in lockstep with tmux.

### 4. setImmediate Output Coalescing (pre-v0.52.3)

**Approach:** Coalesce output within a single `setImmediate` tick.

**Why it failed:** TUI frames span multiple I/O ticks. `setImmediate`
only captures one tick's worth of `%output` lines, splitting frames
across multiple WebSocket messages. xterm.js renders each message
independently, producing visible tearing.

**Resolution:** Dual-timer coalescer (2ms idle + 16ms cap).

### 5. Fixed 8ms Timer Coalescing

**Approach:** Fixed 8ms delay before flushing.

**Why it failed:** Too short for slow TUI apps (missed tail end of
frames), too long for interactive typing (added perceptible latency).
One timer cannot serve both use cases.

**Resolution:** Idle timer (adapts to actual output rate) + hard cap
(bounds worst-case latency).

### 6. Resize Without Idle Gate

**Approach:** Send `refresh-client -C` to tmux immediately on every
resize message.

**Why it failed:** During window drag, the browser fires dozens of
resize events per second. Each triggers a SIGWINCH in the PTY, causing
the running TUI app to redraw mid-frame while the *previous* redraw is
still being emitted. The interleaved escape sequences produce garbled
output.

**Resolution:** 50ms idle gate — defer resize until output has been
quiet for 50ms, with a 500ms hard deadline so resize isn't blocked
forever by continuous output.

## Invariants

These must hold for correct rendering. Violating any one causes garble.

1. **No string conversion before the parser.** Raw stdout bytes must
   reach `tmux-output-parser.js` as Buffers. Any `toString()` or
   `StringDecoder` on the raw stream corrupts multi-byte characters
   split at chunk boundaries.

2. **One persistent StringDecoder per parser.** The decoder carries
   partial multi-byte sequences across `%output` lines. Creating a new
   decoder per line loses the carry and emits U+FFFD.

3. **Octal unescape in byte space.** The `\NNN` → byte conversion must
   operate on Buffers, not strings. String-level unescape causes latin1
   double-encoding of literal high bytes.

4. **Coalesce before relay.** Individual `%output` lines must be merged
   before sending to clients. Sending per-line breaks xterm.js
   synchronized rendering.

5. **Resize after idle.** Dimension changes must wait for output to
   settle. Resizing mid-frame interleaves old and new escape sequences.

6. **Single shared headless.** The server-side ScreenState must reflect
   the current PTY dimensions. Per-client headless at different
   dimensions produces wrong absolute cursor positioning.

7. **Client controls pull pace.** The next pull fires only after xterm
   finishes rendering. Server-driven push without backpressure
   overwhelms slow clients and causes buffer bloat.
