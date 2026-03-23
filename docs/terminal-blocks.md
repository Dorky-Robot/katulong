# Terminal Blocks

A new rendering model where each command and its output lives in its own container — like a notebook for the terminal.

## The idea

Today, katulong renders a single continuous terminal stream via xterm.js. Every command, its output, and the next prompt all flow into one scrollback buffer. This is how terminals have worked since the 1970s.

Terminal Blocks changes this. Each command cycle becomes a discrete, interactive block:

```
┌─────────────────────────────────────────────┐
│ $ git status                            📌 ▼│
├─────────────────────────────────────────────┤
│ On branch main                              │
│ Changes not staged for commit:              │
│   modified:   public/app.js                 │
│   modified:   lib/session.js                │
│                                             │
│ [Copy] [Re-run] [Pin]              exit: 0  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ $ npm test                              📌 ▼│
├─────────────────────────────────────────────┤
│ > katulong@1.0.0 test                       │
│ > node --test test/**/*.test.js             │
│                                             │
│ ✓ auth (42ms)                               │
│ ✓ session lifecycle (18ms)                  │
│ ✓ cookie parsing (3ms)                      │
│                                             │
│ [Copy] [Re-run] [Pin] [Collapse]    exit: 0 │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ $ _                                         │  ← active block (live xterm)
└─────────────────────────────────────────────┘
```

The active command runs in a live xterm.js instance — full color, interactivity, TUI support. Completed commands get frozen into lightweight HTML snapshots with a block toolbar.

## Why this matters

**The terminal is the only dev tool where output is disposable by default.** You run a test, it scrolls past, and it's gone. You can scroll back, but there's no way to act on a specific result.

Blocks make terminal output into objects you can interact with:

- **Pin** a block to keep it visible while you work below it
- **Pull out** a block into a floating panel or second pane
- **Collapse** long output to keep your workspace clean
- **Copy** the full output of a single command without careful selection
- **Re-run** a command with one tap
- **Compare** two runs side-by-side by pulling both out
- **Share** a block as a link or image

This is especially powerful on mobile, where scrolling back through a continuous terminal to find output is painful. Blocks turn the terminal into something you can navigate by command, not by screenful.

## How it works

### Shell integration layer

Blocks need to know where one command ends and the next begins. This is done through **shell integration** — the shell emits invisible escape sequences that mark command boundaries:

```
OSC 133;A ST   →  prompt started
OSC 133;B ST   →  command execution started (user hit Enter)
OSC 133;C ST   →  command output started
OSC 133;D;N ST →  command finished with exit code N
```

These are the same sequences used by VS Code, iTerm2, and Warp for their shell integration features. Katulong would inject these via shell hooks:

- **zsh**: `precmd` / `preexec` functions
- **bash**: `PROMPT_COMMAND` / `trap DEBUG`
- **fish**: `fish_prompt` / `fish_preexec`

The shell integration script would be auto-sourced when a katulong tmux session starts — transparent to the user.

### Block lifecycle

```
[Prompt] ──user types──→ [Active Block] ──Enter──→ [Running Block] ──exit──→ [Frozen Block]
                              │                          │                        │
                         live xterm.js              live xterm.js           static HTML snapshot
                         full interactivity         streaming output        block toolbar visible
                                                    cancel button           lightweight / recyclable
```

1. **Active Block** — The current prompt. Rendered in a live xterm.js instance. Full keyboard input, autocomplete, everything works exactly like today.

2. **Running Block** — Command is executing. Still a live xterm.js instance (needed for TUI apps like vim, htop, interactive prompts). Shows a subtle "running" indicator. Output streams in real-time.

3. **Frozen Block** — Command completed. The xterm.js instance is snapshot into static HTML (preserving colors and formatting), and the terminal instance is recycled back to the pool. A toolbar appears with actions.

### Graceful degradation

Not every shell session will have integration markers. Katulong must handle this:

- **No shell integration detected**: Fall back to the current single continuous terminal. No blocks, no toolbar. Everything works exactly as it does today.
- **Partial integration** (e.g., user switches to a subshell without hooks): Merge unmarked output into the previous block until markers resume.
- **Long-running interactive commands** (vim, htop, ssh): Stay as a live xterm.js instance — never freeze. The block boundary happens when the command exits.

## Block actions

Each frozen block gets a toolbar. Actions are designed for real workflows, not feature demos.

### Core actions

| Action | What it does | Why |
|--------|-------------|-----|
| **Copy** | Copies the block's text output to clipboard | No more careful click-drag to select just one command's output |
| **Re-run** | Sends the command to the active block | One-tap retry; especially useful on mobile |
| **Pin** | Keeps the block visible at the top of the viewport | Watch test output while editing code below |
| **Collapse** | Shrinks the block to just the command line | Clean up noise from successful commands |

### Extended actions

| Action | What it does | Why |
|--------|-------------|-----|
| **Pull out** | Detaches the block into a floating panel | Compare two outputs, keep a reference visible |
| **Split** | Opens the block in the secondary split pane | Side-by-side with the active terminal |
| **Diff** | Compare two blocks visually | Before/after a code change |
| **Wrap/Nowrap** | Toggle line wrapping on the output | Long lines in logs, wide table output |
| **Search** | Find within this block's output | Faster than terminal-wide Ctrl+F |

### Mobile-specific actions

On touch devices, blocks are navigable by swipe. Swipe right on a block to reveal the action tray (like iOS mail). Tap a block header to collapse/expand. This replaces the awkward scroll-and-find pattern that makes terminals painful on phones and tablets.

## Pinned blocks

Pinning is the flagship interaction. A pinned block sticks to the top of the terminal viewport (or a dedicated "pinned" shelf) while new commands scroll below it.

Use cases:
- Pin a failing test's output, then edit and re-run below it
- Pin `docker logs -f` output while running commands in another block
- Pin a `curl` response while composing the next request
- Pin `env` output for reference while debugging

Pinned blocks can be resized vertically. Multiple pinned blocks stack. Unpin by clicking the pin icon or swiping.

## Pulled-out blocks

Pull out goes further than pinning — it removes the block from the terminal flow entirely and places it in a **floating panel** (desktop) or **slide-over sheet** (mobile/tablet).

This is powerful for:
- Keeping API docs output visible while coding
- Comparing `git diff` output with test results
- Reference outputs during long debugging sessions

Pulled-out blocks are lightweight (static HTML), so having several open doesn't impact performance.

## Technical approach

### What we keep

- **xterm.js** — The terminal emulator stays. It handles ANSI parsing, cursor movement, alternate screen buffer, mouse reporting, and TUI rendering. Replacing it would be months of work for no user benefit.
- **tmux backend** — Sessions still run in tmux. The server doesn't change.
- **WebSocket transport** — Same byte-sequenced output stream. Blocks are a frontend-only concept.
- **Pull-based output** — The client-driven pull loop maps cleanly to block boundaries (byte ranges per command).

### What we add

1. **Shell integration script** (`~/.katulong/shell-integration.sh`) — Auto-sourced in katulong sessions. Emits OSC 133 markers.

2. **Block parser** (frontend) — Registers `term.parser.registerOscHandler(133, ...)` on the xterm.js instance. Tracks command boundaries as byte ranges. Emits events: `block:start`, `block:running`, `block:complete`.

3. **Block manager** (frontend) — Owns the block DOM. Creates block containers, manages the active xterm.js instance, handles freeze/thaw of blocks, and coordinates pinning/pull-out.

4. **Snapshot renderer** — When a block freezes, captures the xterm.js rendered output as HTML (preserving ANSI colors via xterm's serialize addon) and replaces the live terminal with static content.

5. **Block toolbar** (frontend) — Action buttons rendered per block. Touch-friendly, context-aware (e.g., "Re-run" only on blocks with a parseable command).

### Architecture

```
┌─ Browser ──────────────────────────────────────────────┐
│                                                         │
│  ┌─ Block Manager ───────────────────────────────────┐  │
│  │                                                    │  │
│  │  ┌─ Frozen Block ─────────┐  ┌─ Frozen Block ──┐  │  │
│  │  │ static HTML + toolbar  │  │ static HTML      │  │  │
│  │  └────────────────────────┘  └──────────────────┘  │  │
│  │                                                    │  │
│  │  ┌─ Active Block ─────────────────────────────┐   │  │
│  │  │ live xterm.js instance                      │   │  │
│  │  │ (from terminal pool)                        │   │  │
│  │  └─────────────────────────────────────────────┘   │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
│                         │                                │
│                    Block Parser                          │
│                  (OSC 133 handler)                        │
│                         │                                │
│                    pull loop                               │
│                         │                                │
│                    WebSocket                             │
└─────────────────────────────────────────────────────────┘
                          │
                       Server
                     (unchanged)
```

### What stays unchanged

The server, tmux layer, session management, WebSocket protocol, and authentication are not affected. Terminal Blocks is entirely a frontend rendering change. The byte stream is identical — blocks are just a different way of displaying it.

## Phases

### Phase 1: Shell integration + block detection
- Write shell integration scripts for zsh, bash, fish
- Auto-source them in katulong tmux sessions
- Register OSC 133 handler on xterm.js
- Emit block boundary events with byte ranges
- Visual: subtle separator lines between commands (no toolbar yet)

### Phase 2: Block containers + freeze/thaw
- Render each command in its own DOM container
- Active command uses live xterm.js
- Completed commands freeze to static HTML snapshots
- Basic toolbar: Copy, Re-run, Collapse
- Graceful fallback when shell integration is absent

### Phase 3: Pin + Pull out
- Pinned block shelf at viewport top
- Pull-out to floating panels (desktop) / slide-over (mobile)
- Block drag-and-drop reordering
- Multi-pin support with resize handles

### Phase 4: Advanced interactions
- Block diff (compare two blocks)
- Block search (find within a single block)
- Block sharing (link or image export)
- Split-pane block placement
- Keyboard navigation between blocks

## Open questions

- **Alternate screen apps**: When vim or htop takes over the terminal (alternate screen buffer), should that be its own block? Or should blocks only apply to normal-mode commands?
- **Multiline commands**: How do we handle heredocs, multiline pipes, and commands that span multiple lines?
- **Background jobs**: A backgrounded process (`cmd &`) may produce output after the next prompt appears. Which block owns that output?
- **tmux pane output**: If the user has tmux splits within their session, block detection only works in the pane with shell integration. Is that confusing or acceptable?
- **Performance**: How many frozen blocks before the DOM gets heavy? Should we virtualize (only render visible blocks)?
- **Scrollback replay**: When reconnecting, the server replays the RingBuffer. Can we reconstruct block boundaries from replayed output, or are they lost?
