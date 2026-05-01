// --- RingBuffer ---

export class RingBuffer {
  constructor(maxBytes = 20 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.items = [];
    this.offsets = [];     // byte offset of each item in the cumulative stream
    this.bytes = 0;
    this.totalBytes = 0;   // cumulative bytes ever pushed (monotonic, never reset)
  }

  push(data) {
    this.offsets.push(this.totalBytes);
    this.totalBytes += data.length;
    this.items.push(data);
    this.bytes += data.length;
    this.evict();
  }

  evict() {
    let removeCount = 0;
    while (
      this.items.length - removeCount > 1 &&
      this.bytes > this.maxBytes
    ) {
      this.bytes -= this.items[removeCount].length;
      removeCount++;
    }
    if (removeCount > 0) {
      this.items.splice(0, removeCount);
      this.offsets.splice(0, removeCount);
    }
  }

  toString() {
    return this.items.join("");
  }

  clear() {
    this.items = [];
    this.offsets = [];
    this.bytes = 0;
    // totalBytes is NOT reset — sequence persists across clears
  }

  /**
   * Rehydrate the buffer from a persisted snapshot (lib/scrollback-store.js).
   *
   * `endOffset` is the cursor position at the END of `data` — i.e. the
   * value `totalBytes` had when the snapshot was taken. The starting
   * offset of the rehydrated item is therefore `endOffset - data.length`,
   * which preserves the invariant that pre-restart `seq` cursors handed
   * out to clients still resolve to the right slice via `sliceFrom()`.
   *
   * Existing buffer state is dropped — restore is meant for the empty
   * post-construction RingBuffer on the restoreSessions() path. Calling
   * it on a live buffer with already-streamed bytes would discard them.
   */
  restore(data, endOffset) {
    if (typeof data !== "string") return;
    if (!Number.isFinite(endOffset) || endOffset < 0) return;
    if (endOffset < data.length) return;
    this.items = data.length > 0 ? [data] : [];
    this.offsets = data.length > 0 ? [endOffset - data.length] : [];
    this.bytes = data.length;
    this.totalBytes = endOffset;
  }

  /** Returns the byte offset of the first buffered item, or totalBytes if empty. */
  getStartOffset() {
    return this.offsets.length > 0 ? this.offsets[0] : this.totalBytes;
  }

  /** Returns the cumulative byte offset (end of stream). */
  getEndOffset() {
    return this.totalBytes;
  }

  /**
   * Returns concatenated string of all items from `offset` onward.
   * Returns null if the requested offset has been evicted.
   */
  sliceFrom(offset) {
    if (this.offsets.length === 0) {
      return offset === this.totalBytes ? "" : null;
    }
    if (offset < this.offsets[0]) return null; // data evicted
    if (offset >= this.totalBytes) return "";

    // Binary search for first item with offset >= requested offset
    let lo = 0, hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.offsets[mid] < offset) lo = mid + 1;
      else hi = mid;
    }

    // lo is the first item whose start offset >= requested offset
    // If the requested offset falls within a previous item, we need the item before
    if (this.offsets[lo] > offset && lo > 0) {
      lo--;
    }

    // Calculate how much to skip from the first item
    let skipBytes = offset - this.offsets[lo];
    // Guard against slicing mid-surrogate-pair.  JavaScript strings use
    // UTF-16: characters above U+FFFF (emoji, etc.) are stored as two
    // code units (a high surrogate 0xD800-0xDBFF followed by a low
    // surrogate 0xDC00-0xDFFF).  If skipBytes lands between the pair,
    // string.slice() would produce a lone surrogate that renders as the
    // U+FFFD replacement character (diamond ?) in terminal emulators.
    // Adjust backwards to include the full surrogate pair.
    if (skipBytes > 0 && skipBytes < this.items[lo].length) {
      const code = this.items[lo].charCodeAt(skipBytes);
      if (code >= 0xDC00 && code <= 0xDFFF) {
        // We're at a low surrogate — back up one to include the high surrogate
        skipBytes--;
      }
    }
    const parts = [];
    if (skipBytes > 0) {
      parts.push(this.items[lo].slice(skipBytes));
    } else {
      parts.push(this.items[lo]);
    }
    for (let i = lo + 1; i < this.items.length; i++) {
      parts.push(this.items[i]);
    }
    return parts.join("");
  }

  stats() {
    return {
      items: this.items.length,
      bytes: this.bytes,
    };
  }
}
