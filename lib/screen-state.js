import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
import { DEFAULT_COLS, TERMINAL_ROWS_DEFAULT, TERMINAL_SCROLLBACK } from "./terminal-config.js";

const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

/**
 * ScreenState — server-side mirror of a terminal's visible state.
 *
 * Wraps a headless `@xterm/headless` Terminal plus the SerializeAddon and
 * the current dimensions. Used by Session to:
 *   - mirror %output bytes
 *   - serialize the visible screen for snapshot delivery to clients
 *     (attach, resize, reconnect, subscribe)
 *   - resize in lockstep with the live tmux pane
 *
 * Raptor 3 deleted drift detection, so ScreenState no longer exposes a
 * fingerprint. It is now purely a write-target and serialize source —
 * the single source of truth for "what the terminal looks like right now".
 *
 * Disposal is idempotent and observable via the `disposed` getter — every
 * mutator no-ops once the underlying terminal is gone, so deferred timer
 * callbacks (e.g. a delete firing during a pending snapshot) can call
 * into a freshly-killed session without throwing.
 */
export class ScreenState {
  constructor() {
    this._term = new Terminal({
      cols: DEFAULT_COLS,
      rows: TERMINAL_ROWS_DEFAULT,
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
    });
    this._serializer = new SerializeAddon();
    this._term.loadAddon(this._serializer);
    this._cols = DEFAULT_COLS;
    this._rows = TERMINAL_ROWS_DEFAULT;
  }

  /** Current cols of the underlying mirror. */
  get cols() { return this._cols; }

  /** Current rows of the underlying mirror. */
  get rows() { return this._rows; }

  /** True once `dispose()` has run; mutators are no-ops afterwards. */
  get disposed() { return this._term === null; }

  /**
   * Underlying xterm.js Terminal instance.
   *
   * Exposed for tests that need to inspect buffer state directly.
   * Production code should use write/resize/serialize — reaching for
   * `term` bypasses dispose tracking.
   */
  get term() { return this._term; }

  /** Write decoded %output bytes into the mirror. No-op once disposed. */
  write(data) {
    if (!this._term) return;
    this._term.write(data);
  }

  /**
   * Resize the mirror in lockstep with tmux. The dimensions are tracked
   * here so callers can short-circuit no-op resizes without touching the
   * xterm Terminal directly.
   */
  resize(cols, rows) {
    if (!this._term) return;
    this._cols = cols;
    this._rows = rows;
    this._term.resize(cols, rows);
  }

  /**
   * Seed the mirror from tmux capture-pane content (server-restart path).
   *
   * After a Node restart, the headless mirror is empty because tmux control
   * mode only sends %output for NEW data — it never replays the existing
   * pane. Idle sessions therefore serialize as blank tiles unless we seed
   * them from the live pane snapshot.
   *
   * Cursor position is set via a CUP escape (1-based row/col, matching
   * tmux capture-pane's cursor_x/cursor_y format).
   */
  async seed(content, cursorPos = null) {
    if (!this._term || !content) return;
    await new Promise(resolve => this._term.write(content, resolve));
    if (this._term && cursorPos && cursorPos.row >= 1 && cursorPos.col >= 1) {
      const cup = `\x1b[${cursorPos.row};${cursorPos.col}H`;
      await new Promise(resolve => this._term.write(cup, resolve));
    }
  }

  /**
   * Wait for any pending xterm.js writes to drain.
   *
   * xterm.js batches writes through an internal `_innerWrite` queue
   * and fires the per-write callback once the batch has been processed;
   * without flushing first, `serialize()` sees stale state and the
   * snapshot we ship to clients skips cursor movements and styling from
   * the most recent %output lines.
   *
   * Note: xterm's write drain is scheduled via `setTimeout`, not a
   * microtask. Callers that await `flush()` will therefore yield to
   * the Node event loop, which means fresh %output bytes from tmux
   * may arrive during the await. Session._applyResize handles this
   * by resizing ScreenState BEFORE awaiting serialize, so any bytes
   * that land mid-flush are written into the new-dim buffer and show
   * up in the snapshot we emit — and are also coalesced normally
   * through the onData path at new dims.
   *
   * Returns false if the screen has been disposed during the await so
   * callers can bail safely (the session can be killed while a deferred
   * timer is mid-flush).
   */
  async flush() {
    if (!this._term) return false;
    await new Promise(resolve => this._term.write("", resolve));
    return this._term !== null;
  }

  /**
   * Snapshot the mirror as escape sequences for client replay.
   *
   * Always flushes first so the returned escape sequence reflects every
   * write the caller has made up to this point — see `flush()` for why
   * this matters.
   */
  async serialize() {
    const ready = await this.flush();
    if (!ready) return "";
    return this._serializer.serialize();
  }

  /**
   * Cursor position as `{ x, y }` (0-based, matching xterm.js conventions).
   * Returns null once disposed. Exposed primarily for tests that need to
   * verify seed() positioning without reaching into the underlying buffer.
   */
  get cursor() {
    if (!this._term) return null;
    const buf = this._term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  /** Dispose the underlying headless terminal. Idempotent. */
  dispose() {
    if (this._term) {
      this._term.dispose();
      this._term = null;
    }
  }
}
