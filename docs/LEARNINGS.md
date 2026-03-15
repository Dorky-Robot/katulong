# Learnings Log

Lessons learned from shipping, debugging, and iterating on katulong. Each entry captures what broke, why, and how we prevent it from happening again.

---

## 2026-03-15: Clipboard bridge regression in containers (PR #357)

**What broke**: Image paste from iPad to Claude Code inside a kubo container showed "No image found in clipboard." The same flow worked on bare macOS.

**Root cause**: `DISPLAY` environment variable was empty. Xvfb was running on `:99` (started by entrypoint.sh), but the env var didn't propagate to:
1. katulong's process (started manually, not via entrypoint)
2. tmux sessions (started before DISPLAY was set)
3. Claude Code (child process of tmux, inherits tmux's env)

Without DISPLAY, `xclip` fails silently on both write (upload route) and read (Claude Code), so the X clipboard was never set.

**Fix**: Auto-detect Xvfb at server startup and in the upload route via `pgrep -a Xvfb`. Set `process.env.DISPLAY` and propagate to tmux via `tmux setenv -g DISPLAY :99`.

**Prevention**:
- Added `test/clipboard-bridge.test.js` with xclip round-trip tests and DISPLAY detection tests
- Documented the container use case in `docs/clipboard-bridge.md`
- Added "What NOT to change" rule #8: do not remove Xvfb auto-detection

---

## 2026-03-15: P2P silently dropping terminal output (PR #357)

**What broke**: Last bits of Claude Code output didn't arrive in the browser. User had to refresh to see that Claude Code was done.

**Root cause**: `peer.send()` in `lib/p2p.js` returned `undefined` when the DataChannel wasn't open (silently swallowed data). The caller in `ws-manager.js` always hit `continue` after `send()` (no exception thrown), skipping the WebSocket fallback. Data was lost.

**Fix**: `peer.send()` now returns `true`/`false`. The caller only skips WebSocket if P2P actually delivered.

**Prevention**:
- Added P2P send fallback tests in `test/clipboard-bridge.test.js`
- Added "What NOT to change" rule #7 in clipboard-bridge.md

---

## 2026-03-15: Can't scroll up while Claude Code is outputting (PR #357)

**What broke**: When Claude Code was actively generating output, scrolling up was impossible — the terminal snapped back to the bottom every frame.

**Root cause**: `terminalWriteWithScroll()` checked `isAtBottom()` before each batched write (~16ms via RAF). Since the previous write had just scrolled to bottom, it always returned `true`. The user couldn't scroll up faster than 60fps.

**Fix**: Added scroll-lock tracking via `wheel`/`touchmove` events. When the user scrolls away from bottom, a per-viewport lock suppresses auto-scroll. Lock clears when viewport reaches bottom (any means).

**Prevention**:
- Scroll lock uses a WeakMap keyed on viewport element (GC-friendly, per-terminal)
- `scrollToBottom()` explicitly clears the lock

---

## 2026-03-15: Shift+Enter not working in Claude Code via katulong (PR #357)

**What broke**: Pressing Shift+Enter in Claude Code (through katulong) submitted the input instead of inserting a newline.

**Root cause**: katulong sent `\x1b[200~\r\x1b[201~` (a carriage return wrapped in bracketed paste markers). Claude Code likely special-cases single-character pastes or doesn't treat a pasted `\r` as a newline insertion.

**Fix**: Send `\x1b[13;2u` (kitty keyboard protocol CSI u sequence: key=13 Enter, modifier=2 Shift). Claude Code recognizes this as Shift+Enter.

**Prevention**:
- Updated e2e test to verify CSI u sequence
- Documented the reasoning in code comments

---

## 2026-03-15: Text paste missing bracketed paste wrapping (PR #357)

**What broke**: Multiline text pasted via Ctrl+V was treated as multiple Enter submissions instead of literal text insertion.

**Root cause**: `onTextPaste` in `app.js` used `rawSend(text)` which bypassed xterm.js. xterm.js normally wraps pasted text in bracketed paste markers (`\x1b[200~...\x1b[201~`). Without markers, each newline was treated as Enter/submit by Claude Code.

**Fix**: Changed to `term.paste(text)` which goes through xterm.js's paste handling, including bracketed paste wrapping when the app has enabled it.

**Prevention**:
- Code comment explains why `term.paste()` is necessary
- Falls back to `rawSend()` only when no terminal is available
