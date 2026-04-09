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
 *   - mirror %output bytes for serialization on attach/subscribe/resync
 *   - compute a screen fingerprint for drift detection
 *   - resize in lockstep with the live tmux pane
 *
 * Owns no byte-stream sequence concept on purpose. Callers (Session) are
 * responsible for pairing `computeHash()` with `outputBuffer.totalBytes`
 * so the resulting `{ hash, seq }` pair describes the SAME Lamport instant
 * on both client and server. See `Session.screenFingerprint()` for the
 * orchestration that captures `seq` between `flush()` and `computeHash()`.
 *
 * Disposal is idempotent and observable via the `disposed` getter — every
 * mutator no-ops once the underlying terminal is gone, so deferred timer
 * callbacks (e.g. resync polling) can call into a freshly-killed session
 * without throwing.
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
   * Exposed for client/server fingerprint parity tests that must call the
   * client-side fingerprint() function with the SAME Terminal the server
   * just hashed. Production code should use write/resize/serialize/
   * computeHash instead — reaching for `term` directly bypasses dispose
   * tracking.
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
   * xterm.js batches writes via microtasks; without flushing first,
   * `serialize()` and `computeHash()` see stale state and the snapshot
   * skips cursor movements / styling that the next pull will also skip
   * (because the pull starts from `outputBuffer.totalBytes`). The result
   * is garbled output where the live data is applied on top of a stale
   * mirror.
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
   *
   * Appends a DECSTBM (scroll region) emit if the active buffer has a
   * non-default region. SerializeAddon does NOT serialize DECSTBM — it
   * only emits visible cell content and attrs. TUI apps that pin a
   * footer by setting a scroll region above it (notably Claude Code)
   * would otherwise lose the region on every attach/subscribe/resync
   * replay, and subsequent streaming writes would scroll the pinned
   * footer out of view. The fix is to read the active buffer's
   * scrollTop/scrollBottom (xterm.js internals, 0-indexed) and append
   * `DECSC ; DECSTBM ; DECRC` — save cursor, set region, restore
   * cursor — so the region lands without disturbing the cursor
   * position that SerializeAddon just established at the tail of its
   * output. DECSTBM otherwise moves cursor to home, which would
   * corrupt the replay. The region is emitted AFTER the body so it
   * lands on whichever buffer SerializeAddon finished in (alt buffer
   * for apps that run in alt-screen like Claude Code).
   */
  async serialize() {
    const ready = await this.flush();
    if (!ready) return "";
    const body = this._serializer.serialize();
    const buf = this._term._core?.buffers?.active;
    if (!buf) return body;
    const st = buf.scrollTop, sb = buf.scrollBottom;
    if (st === 0 && sb === this._term.rows - 1) return body;
    return body + `\x1b7\x1b[${st + 1};${sb + 1}r\x1b8`;
  }

  /**
   * Compute the DJB2 fingerprint of the visible screen state.
   *
   * The same algorithm runs on the client (public/lib/screen-fingerprint.js)
   * — both sides hash dimensions, then cursor (Y, X), then every visible row
   * via `translateToString(true)`. Any divergence in field order or encoding
   * here breaks drift detection silently (state-check always reports
   * mismatch, every mismatch triggers a resync, every resync nukes the
   * screen).
   *
   * Caller is responsible for awaiting `flush()` first AND for capturing
   * the byte-stream `seq` *between* flush and computeHash so the resulting
   * `{ hash, seq }` pair describes the same Lamport instant. ScreenState
   * does not know about RingBuffer / totalBytes by design.
   */
  computeHash() {
    if (!this._term) return 0;
    const buf = this._term.buffer.active;
    let h = 5381;
    h = ((h << 5) + h + this._term.cols) | 0;
    h = ((h << 5) + h + this._term.rows) | 0;
    h = ((h << 5) + h + buf.cursorY) | 0;
    h = ((h << 5) + h + buf.cursorX) | 0;
    for (let y = 0; y < this._term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) continue;
      const text = line.translateToString(true);
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      }
    }
    return h;
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
