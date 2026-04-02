/**
 * Shared terminal configuration constants.
 *
 * All terminals (client xterm.js, server headless xterm, tmux PTY)
 * must use the same column width to avoid horizontal reflow garble.
 * Rows are dynamic per-client (based on viewport height).
 */

export const TERMINAL_COLS = 82;
export const TERMINAL_ROWS_DEFAULT = 24;
export const TERMINAL_SCROLLBACK = 200;
