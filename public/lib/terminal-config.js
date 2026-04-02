/**
 * Shared terminal configuration constants (client-side copy).
 * Must match lib/terminal-config.js on the server.
 *
 * DEFAULT_COLS is a fallback used when the client can't calculate
 * cols from its viewport. Each client calculates its own column
 * count from contentWidth / charWidth in scaleToFit.
 */

export const DEFAULT_COLS = 82;
export const TERMINAL_ROWS_DEFAULT = 24;

/** @deprecated Use DEFAULT_COLS -- columns are no longer a hard constraint. */
export const TERMINAL_COLS = DEFAULT_COLS;
