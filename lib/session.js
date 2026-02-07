import { RingBuffer } from "./ring-buffer.js";
import { execSync } from "node:child_process";

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
   * Check if the session has child processes (processes running in the terminal)
   * This helps detect if there are active jobs that would be killed when removing the session.
   * @returns {boolean} True if there are child processes beyond the shell
   */
  hasChildProcesses() {
    if (!this.alive) {
      return false;
    }

    try {
      // Use pgrep to find child processes of this PTY's PID
      // The shell itself is a child of the PTY, so we check if there are
      // any processes beyond just the shell (i.e., running commands)
      const output = execSync(`pgrep -P ${this.pid}`, { encoding: "utf8" }).trim();

      if (!output) {
        return false;
      }

      // Get the list of child PIDs
      const childPids = output.split("\n").filter(Boolean);

      // If there's only one child (the shell), check if IT has children
      if (childPids.length === 1) {
        const shellPid = childPids[0];
        try {
          const grandchildren = execSync(`pgrep -P ${shellPid}`, { encoding: "utf8" }).trim();
          return grandchildren.length > 0;
        } catch {
          // No grandchildren
          return false;
        }
      }

      // Multiple direct children means there are running processes
      return childPids.length > 1;
    } catch (err) {
      // pgrep returns exit code 1 if no processes found
      return false;
    }
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
