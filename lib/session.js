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
    // Validate PID is strictly numeric to prevent command injection
    if (!/^\d+$/.test(String(pid))) {
      return 0;
    }

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
        // Validate each child PID before recursion
        if (/^\d+$/.test(childPid)) {
          total += this.#countDescendants(parseInt(childPid, 10));
        }
      }

      return total;
    } catch {
      // No children found
      return 0;
    }
  }

  /**
   * Check if the session has important content that should be preserved
   * This includes:
   * - Currently running processes
   * - Evidence of Claude Code having been run (conversation history)
   * @returns {boolean} True if the session should be protected from deletion
   */
  hasChildProcesses() {
    if (!this.alive) {
      return false;
    }

    try {
      // Check for currently running processes
      const totalDescendants = this.#countDescendants(this.pid);
      if (totalDescendants > 1) {
        return true;
      }

      // Check if Claude Code has been run in this session
      // Even if Claude has exited, the session contains valuable conversation history
      const buffer = this.getBuffer();
      const claudeIndicators = [
        "Claude Code",
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
        "Sonnet 4.5",
        "Opus 4.6",
        "Haiku 4.5",
        "anthropic.com",
        "~/Projects/", // Claude Code working directory pattern
      ];

      return claudeIndicators.some((indicator) => buffer.includes(indicator));
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
