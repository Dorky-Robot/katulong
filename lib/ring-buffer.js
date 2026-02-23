/**
 * RingBuffer - A circular buffer with dual limits (item count and byte size)
 *
 * Automatically evicts oldest items when either limit is exceeded.
 * Used for storing terminal output with bounded memory usage.
 */
export class RingBuffer {
  /**
   * @param {number} maxItems - Maximum number of items to store
   * @param {number} maxBytes - Maximum total byte size
   */
  constructor(maxItems = 5000, maxBytes = 5 * 1024 * 1024) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.items = [];
    this.bytes = 0;
  }

  /**
   * Add data to the buffer and evict oldest items if limits exceeded
   * @param {string} data - Data to add
   */
  push(data) {
    this.items.push(data);
    this.bytes += data.length;
    this.evict();
  }

  /**
   * Evict oldest items until within limits
   * Always keeps at least one item to handle oversized chunks
   */
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
    }
  }

  /**
   * Get all buffered data as a single string
   * @returns {string}
   */
  toString() {
    return this.items.join("");
  }

  /**
   * Clear all buffered data
   */
  clear() {
    this.items = [];
    this.bytes = 0;
  }

  /**
   * Get current buffer statistics
   * @returns {{ items: number, bytes: number }}
   */
  stats() {
    return {
      items: this.items.length,
      bytes: this.bytes,
    };
  }
}
