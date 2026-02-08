import { describe, it } from "node:test";
import assert from "node:assert";
import { Session, SessionNotAliveError } from "../lib/session.js";

// Mock PTY for testing
class MockPTY {
  constructor(pid = 12345) {
    this.pid = pid;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.written = [];
    this.killed = false;
    this.resized = [];
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write(data) {
    this.written.push(data);
  }

  resize(cols, rows) {
    this.resized.push({ cols, rows });
  }

  kill() {
    this.killed = true;
    // Simulate exit event
    for (const handler of this.exitHandlers) {
      handler({ exitCode: 0, signal: undefined });
    }
  }

  // Test helpers
  simulateData(data) {
    for (const handler of this.dataHandlers) {
      handler(data);
    }
  }

  simulateExit(exitCode = 0, signal = undefined) {
    for (const handler of this.exitHandlers) {
      handler({ exitCode, signal });
    }
  }
}

describe("Session", () => {
  describe("constructor", () => {
    it("creates a session with name and PTY", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      assert.strictEqual(session.name, "test");
      assert.strictEqual(session.pty, pty);
      assert.strictEqual(session.alive, true);
      assert.strictEqual(session.pid, 12345);
    });

    it("initializes output buffer with default limits", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      assert.ok(session.outputBuffer);
      assert.strictEqual(session.outputBuffer.maxItems, 5000);
      assert.strictEqual(session.outputBuffer.maxBytes, 5 * 1024 * 1024);
    });

    it("initializes output buffer with custom limits", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty, {
        maxBufferItems: 100,
        maxBufferBytes: 1024,
      });

      assert.strictEqual(session.outputBuffer.maxItems, 100);
      assert.strictEqual(session.outputBuffer.maxBytes, 1024);
    });

    it("sets up PTY event handlers", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      // Handlers should be registered
      assert.strictEqual(pty.dataHandlers.length, 1);
      assert.strictEqual(pty.exitHandlers.length, 1);
    });
  });

  describe("PTY data handling", () => {
    it("buffers data from PTY", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateData("Hello");
      pty.simulateData(" ");
      pty.simulateData("World");

      assert.strictEqual(session.getBuffer(), "Hello World");
    });

    it("calls onData callback when data arrives", () => {
      const pty = new MockPTY();
      const dataEvents = [];
      const session = new Session("test", pty, {
        onData: (name, data) => {
          dataEvents.push({ name, data });
        },
      });

      pty.simulateData("test data");

      assert.strictEqual(dataEvents.length, 1);
      assert.strictEqual(dataEvents[0].name, "test");
      assert.strictEqual(dataEvents[0].data, "test data");
    });

    it("handles multiple data events", () => {
      const pty = new MockPTY();
      const dataEvents = [];
      const session = new Session("test", pty, {
        onData: (name, data) => {
          dataEvents.push({ name, data });
        },
      });

      pty.simulateData("line1\n");
      pty.simulateData("line2\n");
      pty.simulateData("line3\n");

      assert.strictEqual(dataEvents.length, 3);
      assert.strictEqual(session.getBuffer(), "line1\nline2\nline3\n");
    });
  });

  describe("PTY exit handling", () => {
    it("marks session as not alive on exit", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      assert.strictEqual(session.alive, true);

      pty.simulateExit(0);

      assert.strictEqual(session.alive, false);
    });

    it("calls onExit callback when PTY exits", () => {
      const pty = new MockPTY();
      const exitEvents = [];
      const session = new Session("test", pty, {
        onExit: (name, exitCode, signal) => {
          exitEvents.push({ name, exitCode, signal });
        },
      });

      pty.simulateExit(1, "SIGTERM");

      assert.strictEqual(exitEvents.length, 1);
      assert.strictEqual(exitEvents[0].name, "test");
      assert.strictEqual(exitEvents[0].exitCode, 1);
      assert.strictEqual(exitEvents[0].signal, "SIGTERM");
    });
  });

  describe("write", () => {
    it("writes data to PTY when alive", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.write("echo hello\n");

      assert.strictEqual(pty.written.length, 1);
      assert.strictEqual(pty.written[0], "echo hello\n");
    });

    it("throws SessionNotAliveError when session is dead", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateExit(0);

      assert.throws(
        () => session.write("test"),
        (err) => {
          assert(err instanceof SessionNotAliveError);
          assert.strictEqual(err.sessionName, "test");
          return true;
        }
      );
    });

    it("allows multiple writes", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.write("command1\n");
      session.write("command2\n");
      session.write("command3\n");

      assert.strictEqual(pty.written.length, 3);
    });
  });

  describe("resize", () => {
    it("resizes PTY when alive", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.resize(80, 24);

      assert.strictEqual(pty.resized.length, 1);
      assert.deepStrictEqual(pty.resized[0], { cols: 80, rows: 24 });
    });

    it("does not resize when session is dead", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateExit(0);
      session.resize(80, 24);

      assert.strictEqual(pty.resized.length, 0);
    });

    it("allows multiple resizes", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.resize(80, 24);
      session.resize(120, 40);

      assert.strictEqual(pty.resized.length, 2);
    });
  });

  describe("kill", () => {
    it("kills PTY when alive", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.kill();

      assert.strictEqual(pty.killed, true);
      assert.strictEqual(session.alive, false);
    });

    it("is idempotent (safe to call multiple times)", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      session.kill();
      session.kill();
      session.kill();

      // Should only kill once
      assert.strictEqual(pty.killed, true);
      assert.strictEqual(session.alive, false);
    });

    it("triggers exit callback", () => {
      const pty = new MockPTY();
      const exitEvents = [];
      const session = new Session("test", pty, {
        onExit: (name, exitCode) => {
          exitEvents.push({ name, exitCode });
        },
      });

      session.kill();

      assert.strictEqual(exitEvents.length, 1);
      assert.strictEqual(exitEvents[0].name, "test");
    });
  });

  describe("getBuffer", () => {
    it("returns empty string for new session", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      assert.strictEqual(session.getBuffer(), "");
    });

    it("returns buffered output", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateData("$ ls\n");
      pty.simulateData("file1.txt\n");
      pty.simulateData("file2.txt\n");

      assert.strictEqual(session.getBuffer(), "$ ls\nfile1.txt\nfile2.txt\n");
    });

    it("returns buffer even after session dies", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateData("output before exit\n");
      pty.simulateExit(0);

      assert.strictEqual(session.getBuffer(), "output before exit\n");
    });
  });

  describe("clearBuffer", () => {
    it("clears the output buffer", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateData("test data");
      assert.strictEqual(session.getBuffer(), "test data");

      session.clearBuffer();
      assert.strictEqual(session.getBuffer(), "");
    });
  });

  describe("stats", () => {
    it("returns session statistics", () => {
      const pty = new MockPTY(99999);
      const session = new Session("my-session", pty);

      pty.simulateData("hello");

      const stats = session.stats();

      assert.strictEqual(stats.name, "my-session");
      assert.strictEqual(stats.pid, 99999);
      assert.strictEqual(stats.alive, true);
      assert.strictEqual(stats.buffer.items, 1);
      assert.strictEqual(stats.buffer.bytes, 5);
    });

    it("reflects dead status after exit", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      pty.simulateExit(1);

      const stats = session.stats();
      assert.strictEqual(stats.alive, false);
    });
  });

  describe("toJSON", () => {
    it("serializes to JSON with name, pid, alive, hasChildProcesses", () => {
      const pty = new MockPTY(12345);
      const session = new Session("test", pty);

      const json = session.toJSON();

      assert.strictEqual(json.name, "test");
      assert.strictEqual(json.pid, 12345);
      assert.strictEqual(json.alive, true);
      assert.strictEqual(typeof json.hasChildProcesses, "boolean");
    });

    it("works with JSON.stringify", () => {
      const pty = new MockPTY(12345);
      const session = new Session("test", pty);

      const json = JSON.stringify(session);

      // Should include all fields including hasChildProcesses
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.name, "test");
      assert.strictEqual(parsed.pid, 12345);
      assert.strictEqual(parsed.alive, true);
      assert.strictEqual(typeof parsed.hasChildProcesses, "boolean");
    });
  });

  describe("real-world scenarios", () => {
    it("handles typical terminal interaction", () => {
      const pty = new MockPTY();
      const dataEvents = [];
      const session = new Session("shell", pty, {
        onData: (name, data) => dataEvents.push(data),
      });

      // User types command
      session.write("ls -la\n");

      // Terminal outputs
      pty.simulateData("total 64\n");
      pty.simulateData("drwxr-xr-x  10 user  staff   320 Feb  7 10:00 .\n");
      pty.simulateData("drwxr-xr-x   5 user  staff   160 Feb  6 09:00 ..\n");

      // User types another command
      session.write("pwd\n");
      pty.simulateData("/Users/user/project\n");

      assert.strictEqual(pty.written.length, 2);
      assert.strictEqual(dataEvents.length, 4);
      assert.ok(session.getBuffer().includes("total 64"));
      assert.ok(session.getBuffer().includes("/Users/user/project"));
    });

    it("handles session resize during operation", () => {
      const pty = new MockPTY();
      const session = new Session("shell", pty);

      session.write("vim file.txt\n");
      session.resize(120, 40); // User resizes window

      assert.strictEqual(pty.resized.length, 1);
      assert.strictEqual(pty.written.length, 1);
    });

    it("handles graceful shutdown", () => {
      const pty = new MockPTY();
      const exitEvents = [];
      const session = new Session("shell", pty, {
        onExit: (name, exitCode) => exitEvents.push({ name, exitCode }),
      });

      // User exits
      session.write("exit\n");
      pty.simulateExit(0);

      assert.strictEqual(session.alive, false);
      assert.strictEqual(exitEvents.length, 1);
      assert.strictEqual(exitEvents[0].exitCode, 0);
    });

    it("handles crash (non-zero exit)", () => {
      const pty = new MockPTY();
      const exitEvents = [];
      const session = new Session("shell", pty, {
        onExit: (name, exitCode, signal) => {
          exitEvents.push({ name, exitCode, signal });
        },
      });

      pty.simulateData("Segmentation fault\n");
      pty.simulateExit(139, "SIGSEGV");

      assert.strictEqual(session.alive, false);
      assert.strictEqual(exitEvents[0].exitCode, 139);
      assert.strictEqual(exitEvents[0].signal, "SIGSEGV");
    });
  });

  describe("buffer overflow handling", () => {
    it("respects buffer limits", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty, {
        maxBufferItems: 3,
        maxBufferBytes: 100,
      });

      // Add data that exceeds item limit
      pty.simulateData("line1\n");
      pty.simulateData("line2\n");
      pty.simulateData("line3\n");
      pty.simulateData("line4\n"); // Should evict line1

      const buffer = session.getBuffer();
      assert.ok(!buffer.includes("line1"));
      assert.ok(buffer.includes("line2"));
      assert.ok(buffer.includes("line3"));
      assert.ok(buffer.includes("line4"));
    });
  });

  describe("hasChildProcesses", () => {
    it("returns false for dead session", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);
      session.alive = false;

      const result = session.hasChildProcesses();

      assert.strictEqual(result, false);
    });

    it("returns boolean for alive session", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      const result = session.hasChildProcesses();

      // Should return boolean (actual value depends on system state)
      assert.strictEqual(typeof result, "boolean");
    });

    it("includes hasChildProcesses in toJSON", () => {
      const pty = new MockPTY();
      const session = new Session("test", pty);

      const json = session.toJSON();

      assert.ok("hasChildProcesses" in json);
      assert.strictEqual(typeof json.hasChildProcesses, "boolean");
    });
  });
});

describe("SessionNotAliveError", () => {
  it("includes session name in error message", () => {
    const err = new SessionNotAliveError("my-session");
    assert.ok(err.message.includes("my-session"));
  });

  it("stores session name", () => {
    const err = new SessionNotAliveError("my-session");
    assert.strictEqual(err.sessionName, "my-session");
  });

  it("has correct error name", () => {
    const err = new SessionNotAliveError("test");
    assert.strictEqual(err.name, "SessionNotAliveError");
  });
});
