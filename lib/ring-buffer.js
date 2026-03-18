// --- RingBuffer ---

export class RingBuffer {
  constructor(maxItems = 5000, maxBytes = 5 * 1024 * 1024) {
    this.maxItems = maxItems;
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
      (this.items.length - removeCount > this.maxItems || this.bytes > this.maxBytes)
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
    const skipBytes = offset - this.offsets[lo];
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
