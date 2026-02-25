// --- RingBuffer (inlined from lib/ring-buffer.js) ---

export class RingBuffer {
  constructor(maxItems = 5000, maxBytes = 5 * 1024 * 1024) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
    this.items = [];
    this.bytes = 0;
  }

  push(data) {
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
    }
  }

  toString() {
    return this.items.join("");
  }

  clear() {
    this.items = [];
    this.bytes = 0;
  }

  stats() {
    return {
      items: this.items.length,
      bytes: this.bytes,
    };
  }
}

/**
 * Session - Domain model for terminal PTY sessions
 *
 * Encapsulates the lifecycle and operations of a terminal session,
 * including output buffering, state management, and PTY interaction.
 */

export class SessionNotAliveError extends Error {
  constructor(sessionName) {
    super(`Cannot perform operation on dead session: ${sessionName}`);
    this.name = "SessionNotAliveError";
    this.sessionName = sessionName;
  }
}

export class Session {
  /**
   * Create a new Session
   * @param {string} name - Session name
   * @param {object} pty - PTY process instance
   * @param {object} options - Configuration options
   * @param {number} options.maxBufferItems - Maximum buffer items (default: 5000)
   * @param {number} options.maxBufferBytes - Maximum buffer bytes (default: 5MB)
   * @param {Function} options.onData - Callback for PTY data events
   * @param {Function} options.onExit - Callback for PTY exit events
   */
  constructor(name, pty, options = {}) {
    this.name = name;
    this.pty = pty;
    this.alive = true;
    this.pid = pty.pid;
    this.lastKnownChildCount = 0;

    const {
      maxBufferItems = 5000,
      maxBufferBytes = 5 * 1024 * 1024,
      onData,
      onExit,
    } = options;

    this.outputBuffer = new RingBuffer(maxBufferItems, maxBufferBytes);

    // Set up PTY event handlers
    this.setupEventHandlers(onData, onExit);
  }

  /**
   * Set up PTY event handlers
   * @private
   */
  setupEventHandlers(onDataCallback, onExitCallback) {
    this.pty.onData((data) => {
      this.outputBuffer.push(data);
      if (onDataCallback) {
        onDataCallback(this.name, data);
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.alive = false;
      if (onExitCallback) {
        onExitCallback(this.name, exitCode, signal);
      }
    });
  }

  /**
   * Write data to the PTY
   * @param {string} data - Data to write
   * @throws {SessionNotAliveError} If session is not alive
   */
  write(data) {
    if (!this.alive) {
      throw new SessionNotAliveError(this.name);
    }
    this.pty.write(data);
  }

  /**
   * Resize the PTY
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(cols, rows) {
    if (this.alive) {
      this.pty.resize(cols, rows);
    }
  }

  /**
   * Kill the PTY process
   */
  kill() {
    if (this.alive) {
      this.pty.kill();
      this.alive = false;
    }
  }

  /**
   * Get the buffered output as a string
   * @returns {string}
   */
  getBuffer() {
    return this.outputBuffer.toString();
  }

  /**
   * Clear the output buffer
   */
  clearBuffer() {
    this.outputBuffer.clear();
  }

  /**
   * Check if the session has running child processes.
   * Uses a cached descendant count that is updated asynchronously by the daemon.
   * @returns {boolean} True if the last known descendant count is > 1
   */
  hasChildProcesses() {
    if (!this.alive) {
      return false;
    }
    return this.lastKnownChildCount > 1;
  }

  /**
   * Get session statistics
   * @returns {object}
   */
  stats() {
    return {
      name: this.name,
      pid: this.pid,
      alive: this.alive,
      buffer: this.outputBuffer.stats(),
    };
  }

  /**
   * Serialize to JSON for API responses
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      pid: this.pid,
      alive: this.alive,
      hasChildProcesses: this.hasChildProcesses(),
    };
  }
}
