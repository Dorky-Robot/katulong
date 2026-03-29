# Block-Based Terminal — Design Doc

## Motivation

The traditional terminal model (single PTY, fixed viewport, cursor positioning) creates unsolvable problems for multi-device web terminals:

- **Row mismatch**: one PTY can only have one row count. Multiple devices at different heights garble TUI cursor positioning.
- **Garbled state**: serialize snapshots capture mid-frame TUI state. Pull cursors get reset. Scroll coordination is complex.
- **Scroll is hard**: xterm.js internal scrollback vs native scroll vs touch scroll — endless CSS/event battles.

These aren't implementation bugs. They're fundamental limits of mapping a 1970s fixed-grid terminal model onto modern multi-device web UIs.

## Concept

Each command is an isolated **block** with its own PTY and lifecycle. Commands stack vertically like a chat or notebook. The page scrolls natively.

```
┌─────────────────────────────────────┐
│ $ ls                                │  ← Block 1: completed
│ core  katulong  matrix.sh  test/    │     PTY dead, output frozen
│                                     │
├─────────────────────────────────────┤
│ $ claude "fix the bug"              │  ← Block 2: running
│ ● Reading file...                   │     Live PTY, streaming
│   lib/session.js                    │
│ ● Editing file...                   │
│   ██████████░░ 67%                  │
│                                     │
├─────────────────────────────────────┤
│ $ cargo test                        │  ← Block 3: running (concurrent)
│ test result: ok. 42 passed          │     Started while Block 2 runs
│                                     │
├─────────────────────────────────────┤
│ >                                   │  ← Input: next command
│                                     │     New PTY spawned on Enter
└─────────────────────────────────────┘
```

## Block types

### Completed block
- Command finished (exit code available)
- PTY is killed
- Raw output bytes stored as data
- Rendered as static content (pre-rendered HTML or frozen xterm instance)
- Immutable — no state sync, no garble, no resize issues
- Lightweight — just stored text

### Running block
- Live PTY process
- xterm.js instance rendering live output
- Can receive input (stdin) — for interactive commands
- Terminal dimensions are per-block (each block's xterm is sized to the viewport width × content height)
- When process exits → transitions to completed block

### Input block
- Always at the bottom
- Shell prompt with autocomplete, history
- On Enter → spawns new PTY, creates running block, input block moves below
- Can start a new command while other blocks are still running

## Architecture

```
┌──────────────────────────────────┐
│          Client (Browser)        │
│                                  │
│  ┌────────────┐                  │
│  │ Block List │ ← native scroll │
│  │            │                  │
│  │ [static]   │ ← div with text │
│  │ [static]   │ ← div with text │
│  │ [xterm.js] │ ← live PTY      │
│  │ [input]    │ ← prompt        │
│  └────────────┘                  │
└──────────────┬───────────────────┘
               │ WebSocket
               │
┌──────────────┴───────────────────┐
│          Server                  │
│                                  │
│  PTY Manager                     │
│  ├─ pty-1: /bin/zsh (exited)     │
│  │   └─ output: "core  katu..." │
│  ├─ pty-2: claude (running)      │
│  │   └─ streaming via WS        │
│  └─ pty-3: cargo test (running)  │
│      └─ streaming via WS        │
│                                  │
│  No tmux. Direct node-pty.       │
└──────────────────────────────────┘
```

## Why this solves everything

### No row mismatch
There's no shared viewport. Each block renders at its own height. Completed blocks are just text — no cursor positioning. Running blocks use xterm.js sized to the block's content, not a shared PTY viewport.

### No garble
Completed blocks are frozen data. Running blocks have their own PTY at their own dimensions. No serialize/deserialize. No snapshot timing issues.

### Native scroll
Blocks stack in a div. The page scrolls natively. No xterm internal scroll, no touch-action hacks, no wheel event interception. Just a scrolling page.

### Multi-device works naturally
Each device renders the same block list. Completed blocks are identical everywhere (just text). Running blocks stream live output. No resize coordination needed — each device sizes the xterm to its own viewport width.

### Concurrent commands
Start a new command while others run. Each has its own PTY. No tmux session multiplexing needed.

## What we lose

### TUI persistence across commands
In a traditional terminal, `vim` runs in the same PTY as `ls`. In block mode, each command is a separate PTY. TUI apps (vim, htop) work fine — they just run in their own block. But you can't `cd` in one block and have it affect the next (each block is a new PTY).

**Mitigation**: Track CWD per block. When a block's PTY exits, capture the final CWD. The next block's PTY starts in that directory. Same for environment variables — capture the delta and propagate.

### tmux session persistence
tmux keeps sessions alive across disconnects. Without tmux, PTY processes die if the server restarts.

**Mitigation**: Completed blocks are just data — they survive restarts. Running blocks can be restarted (re-run the command) or we can use process managers (systemd, pm2) for long-running processes. Or keep tmux as an optional backend for persistent sessions.

### Shell features
Tab completion, history, aliases — these rely on the shell running in the PTY. The input block needs its own shell instance for these to work.

**Mitigation**: The input block IS a shell PTY. It just doesn't render output — it captures the command and spawns a new PTY for execution. Or the input block has a persistent shell that `exec`s each command.

## Hybrid approach

Don't replace traditional terminals — offer both:

1. **Terminal tile**: traditional xterm.js + tmux (current katulong)
2. **Block tile**: block-based terminal (new)

Users choose per-tile. Claude Code sessions work best in traditional mode (it's a TUI). Quick commands (`ls`, `git status`, `cargo test`) work best in block mode.

## Reusable components from katulong

- WebSocket transport + auth
- Pull-based streaming (per-block instead of per-session)
- Session persistence (sessions.json → blocks.json)
- Carousel/tile system
- Shortcut bar
- Paste handler
- Touch scroll (just native scroll now)

## Implementation phases

### Phase 1: Block renderer
- Static block list UI (div per block)
- Input box at bottom
- On Enter → spawn PTY, stream output into block
- On exit → freeze block, show exit code

### Phase 2: Concurrent blocks
- Multiple running blocks
- Output routing by block ID
- Scroll to active block

### Phase 3: CWD/env propagation
- Capture CWD on PTY exit
- Next PTY starts in captured CWD
- Environment variable delta tracking

### Phase 4: Hybrid tiles
- Add block tile type alongside terminal tile
- User chooses per-tile
- Shared PTY manager backend
