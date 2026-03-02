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
   * Get the current working directory of the session's shell process.
   * @returns {Promise<string|null>}
   */
  async getCwd() {
    if (!this.alive) return null;
    try {
      const { execFile } = await import("node:child_process");
      return new Promise((resolve) => {
        execFile("lsof", ["-a", "-p", String(this.pid), "-d", "cwd", "-Fn"], (err, stdout) => {
          if (err) return resolve(null);
          const match = stdout.match(/^n(.+)$/m);
          resolve(match ? match[1] : null);
        });
      });
    } catch {
      return null;
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
   * Get a short text preview of the terminal buffer (ANSI-stripped).
   * @param {number} maxLines - Maximum number of lines to return (default: 6)
   * @param {number} maxChars - Maximum chars to scan from end of buffer (default: 2000)
   * @returns {string}
   */
  getPreview(maxLines = 6, maxChars = 2000) {
    const raw = this.outputBuffer.toString();
    if (!raw) return "";
    // Take only the tail to avoid scanning a huge buffer
    const tail = raw.slice(-maxChars);
    // Strip ANSI escape sequences
    const stripped = tail.replace(/\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E])/g, "");
    // Split into lines, take the last N non-empty-ish lines
    const lines = stripped.split("\n");
    const lastLines = lines.slice(-maxLines);
    return lastLines.join("\n");
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
      preview: this.getPreview(),
    };
  }
}
