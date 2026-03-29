# Terminal Sizing: Fixed 80 Columns

## Design Decision

All terminals use **100 columns** (FIXED_COLS). This is pegged on both client and server.

### Why
- Column width is the only dimension that causes **horizontal reflow** (text rewrapping)
- Reflow during resize corrupts cursor-positioned TUI content (garbled text)
- With fixed cols, resize only changes rows — which doesn't cause reflow
- 100 cols balances readability with screen usage on tablets

### Where it's enforced
- **Client**: `public/lib/terminal-pool.js` → `FIXED_COLS = 100`
- **Server**: `lib/session-manager.js` → `DEFAULT_COLS = 100`
- **Headless xterm**: `lib/session.js` → `new Terminal({ cols: 100, ... })`

### Rows
Rows vary based on viewport height. This is safe because changing row count:
- Doesn't cause text reflow
- Only affects how many lines are visible
- TUI apps (Claude Code) use cursor positioning (`\x1b[row;colH`) which must match between server PTY and client terminal

### Row sync
The PTY row count is set by:
1. `attachClient()` — on initial connect, resizes to client's rows
2. Carousel swipe — sends resize message for the focused session
3. `scaleToFit()` — client calculates rows from container height

If rows mismatch (server thinks 40 rows, client has 24), TUI cursor positioning lands on wrong rows → garbled text.
