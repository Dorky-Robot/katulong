/**
 * Shared terminal configuration constants.
 *
 * DEFAULT_COLS is a fallback for initial session creation. Each client
 * calculates its own column count from viewport width and sends it
 * via attach/resize messages. The server headless xterm and tmux PTY
 * resize to match the client's dimensions.
 *
 * Rows are dynamic per-client (based on viewport height).
 *
 * TERMINAL_SCROLLBACK bounds how many historical lines a freshly-attached
 * client can scroll through in xterm.js. On attach, the server replays the
 * session's RingBuffer into a per-client headless xterm, then serializes
 * that screen (current viewport + headless scrollback) down to the client.
 * Anything older than this scrollback window is dropped by the headless
 * before serialization, even though the RingBuffer itself has 20 MB of
 * history. So this constant — not the RingBuffer — is what the user sees
 * as "how far back can I scroll after I attach". See ClientHeadless.
 */

export const DEFAULT_COLS = 82;
export const TERMINAL_ROWS_DEFAULT = 24;
export const TERMINAL_SCROLLBACK = 10000;

/** @deprecated Use DEFAULT_COLS -- columns are no longer a hard constraint. */
export const TERMINAL_COLS = DEFAULT_COLS;
