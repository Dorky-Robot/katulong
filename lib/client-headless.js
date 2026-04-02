import xtermHeadless from "@xterm/headless";
import xtermSerialize from "@xterm/addon-serialize";
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;

/**
 * ClientHeadless — per-client headless xterm that replays from a shared
 * RingBuffer at client-specific dimensions.
 *
 * Each connected client gets its own ClientHeadless so that different
 * screen sizes (cols/rows) produce correctly reflowed terminal state.
 * Data is replayed on demand (not on every push) to avoid N headless
 * writes per %output line.
 */
export class ClientHeadless {
  /**
   * @param {import("./ring-buffer.js").RingBuffer} ringBuffer - shared ring buffer to replay from
   * @param {number} cols - terminal columns
   * @param {number} rows - terminal rows
   * @param {number} scrollback - scrollback line count (default 200)
   */
  constructor(ringBuffer, cols, rows, scrollback = 200) {
    this._ringBuffer = ringBuffer;
    this._headless = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
    });
    this._serializeAddon = new SerializeAddon();
    this._headless.loadAddon(this._serializeAddon);
    this._replayCursor = 0; // byte offset into RingBuffer stream
  }

  /** Terminal column count. */
  get cols() {
    return this._headless.cols;
  }

  /** Terminal row count. */
  get rows() {
    return this._headless.rows;
  }

  /** Current cursor position { x, y }. */
  get cursor() {
    const buf = this._headless.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  /**
   * Replay data from the RingBuffer since our last replay cursor.
   *
   * @returns {{ ok: true } | { evicted: true }}
   *   - `{ ok: true }` — successfully caught up to RingBuffer head.
   *   - `{ evicted: true }` — the RingBuffer evicted data past our cursor;
   *     caller should do a full reset (re-serialize from scratch).
   */
  replay() {
    const data = this._ringBuffer.sliceFrom(this._replayCursor);

    if (data === null) {
      // Our cursor points to evicted data — can't replay the gap
      return { evicted: true };
    }

    if (data.length > 0) {
      this._headless.write(data);
    }

    this._replayCursor = this._ringBuffer.totalBytes;
    return { ok: true };
  }

  /**
   * Serialize the visible terminal screen.
   *
   * Calls replay() first to catch up, then flushes the headless terminal
   * (xterm.js batches writes via microtasks) before serializing.
   *
   * @returns {Promise<string>} escape sequences that reconstruct the terminal state
   */
  async serializeScreen() {
    this.replay();
    await new Promise(resolve => this._headless.write("", resolve));
    return this._serializeAddon.serialize();
  }

  /**
   * Compute a fingerprint of the visible terminal screen for drift detection.
   *
   * Uses DJB2 hash of dimensions + cursor position + visible row content.
   * Same algorithm as Session.screenFingerprint() and the client-side
   * public/lib/screen-fingerprint.js so all three produce identical hashes
   * for identical screen state.
   *
   * @returns {Promise<number>} 32-bit hash
   */
  async screenFingerprint() {
    this.replay();
    await new Promise(resolve => this._headless.write("", resolve));

    const buf = this._headless.buffer.active;
    let h = 5381;
    // Include dimensions — must match client (public/lib/screen-fingerprint.js)
    h = ((h << 5) + h + this._headless.cols) | 0;
    h = ((h << 5) + h + this._headless.rows) | 0;
    h = ((h << 5) + h + buf.cursorY) | 0;
    h = ((h << 5) + h + buf.cursorX) | 0;
    for (let y = 0; y < this._headless.rows; y++) {
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
   * Resize the headless terminal. xterm.js handles reflow automatically.
   *
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    this._headless.resize(cols, rows);
  }

  /**
   * Dispose of the headless Terminal instance and release resources.
   */
  dispose() {
    if (this._headless) {
      this._headless.dispose();
      this._headless = null;
    }
  }
}
