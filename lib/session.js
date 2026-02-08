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
   * Recursively count all descendant processes of a given PID
   * @param {number} pid - The process ID to check
   * @returns {number} Total count of all descendants (children, grandchildren, etc.)
   */
  #countDescendants(pid) {
    try {
      const children = execSync(`pgrep -P ${pid}`, { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);

      if (children.length === 0) {
        return 0;
      }

      // Count direct children plus all their descendants
      let total = children.length;
      for (const childPid of children) {
        total += this.#countDescendants(parseInt(childPid));
      }

      return total;
    } catch {
      // No children found
      return 0;
    }
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
      // Count all descendants of the PTY process
      // If there's more than 1 process in the tree (shell + something else), we have child processes
      const totalDescendants = this.#countDescendants(this.pid);

      // More than 1 descendant means: shell + at least one running process
      return totalDescendants > 1;
    } catch (err) {
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
