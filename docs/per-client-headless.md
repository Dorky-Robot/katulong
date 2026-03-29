# Per-Client Headless xterm — Design Doc

## Problem

One PTY can only have one row count. When multiple devices view the same session at different screen heights, TUI cursor positioning (`\x1b[row;colH`) misaligns on devices that don't match the PTY's row count.

## Solution

Each connected client gets its own headless xterm instance at its own dimensions. All instances receive the same raw PTY bytes. Each renders at its own row count. Serialize/pull is per-client — dimensions always match.

## Architecture

```
tmux PTY (80 cols, rows set by active client)
  │
  ├─ %output bytes ─┬─► Canonical headless (80x24, always exists)
  │                  │     └─ Used for serializeScreen() on new client bootstrap
  │                  │
  │                  ├─► Client A headless (80x45, iPad landscape)
  │                  │     └─ serialize/pull for client A
  │                  │
  │                  └─► Client B headless (80x30, iPhone)
  │                        └─ serialize/pull for client B
  │
  └─ RingBuffer (raw bytes, 20MB, for cursor eviction recovery)
```

## Lifecycle

1. **Session created** → canonical headless xterm at 80x24
2. **Client attaches** → new per-client headless at client's dimensions, seeded from canonical via `serialize() → write()`
3. **PTY output** → fan out to canonical + all per-client instances
4. **Client pulls** → data served from per-client instance's context
5. **Client disconnects** → destroy per-client instance
6. **All clients disconnect** → only canonical remains

## Bootstrap (joining mid-session)

When a client connects to a session that's already running:

1. Serialize the canonical headless xterm (captures full TUI state)
2. Create new per-client headless xterm at client's dimensions
3. Write the serialized state into the per-client instance
4. Resize the per-client instance to the client's row count (xterm handles reflow)
5. From this point, raw PTY bytes go to both canonical and per-client
6. The per-client instance is the source of truth for this client's output

## Memory

- Canonical: ~1-2MB per session (always exists)
- Per-client: ~1-2MB per client×session
- Typical: 2 devices × 3 sessions = 6 per-client instances = ~12MB
- Destroyed on disconnect — no accumulation

## What this eliminates

- Row mismatch garble across devices
- Resize coordination (no resize messages needed)
- PTY row count clobbering between devices
- The entire `scaleToFit → onResize → server resize` pipeline

## What stays the same

- FIXED_COLS=80 (no horizontal reflow)
- Pull-based output streaming
- RingBuffer for cursor eviction recovery
- Terminal pool on the client (xterm.js instances per session)

## Implementation notes

- `Session` class gets a `Map<clientId, Terminal>` for per-client instances
- `notifyDataAvailable` fans out bytes to all per-client instances
- `serializeScreen(clientId)` serializes the per-client instance
- `subscribeClient` creates the per-client instance and seeds it
- `detachClient` destroys per-client instances
- The canonical instance is still used for `pull-snapshot` (cursor eviction)
