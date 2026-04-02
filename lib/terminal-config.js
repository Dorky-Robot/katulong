/**
 * Shared terminal configuration constants.
 *
 * DEFAULT_COLS is a fallback for initial session creation. Each client
 * calculates its own column count from viewport width and sends it
 * via attach/resize messages. The server headless xterm and tmux PTY
 * resize to match the client's dimensions.
 *
 * Rows are dynamic per-client (based on viewport height).
 */

export const DEFAULT_COLS = 82;
export const TERMINAL_ROWS_DEFAULT = 24;
export const TERMINAL_SCROLLBACK = 200;

/** @deprecated Use DEFAULT_COLS -- columns are no longer a hard constraint. */
export const TERMINAL_COLS = DEFAULT_COLS;
