import { describe, it } from "node:test";
import assert from "node:assert";
import {
  Session, SessionNotAliveError, RingBuffer,
  tmuxSessionName, encodeHexKeys, unescapeTmuxOutput, stripDaResponses,
} from "../lib/session.js";

// --- tmux control mode helper tests ---

describe("tmuxSessionName", () => {
  it("replaces dots and colons with underscores", () => {
    assert.strictEqual(tmuxSessionName("my.session"), "my_session");
    assert.strictEqual(tmuxSessionName("host:port"), "host_port");
    assert.strictEqual(tmuxSessionName("a.b:c"), "a_b_c");
  });

  it("preserves valid names", () => {
    assert.strictEqual(tmuxSessionName("default"), "default");
    assert.strictEqual(tmuxSessionName("my-session"), "my-session");
  });
});

describe("encodeHexKeys", () => {
  it("encodes simple text", () => {
    assert.strictEqual(encodeHexKeys("hi"), "68 69");
  });

  it("encodes control characters", () => {
    assert.strictEqual(encodeHexKeys("\r"), "0d");
    assert.strictEqual(encodeHexKeys("\x1b[A"), "1b 5b 41");
  });

  it("encodes empty string", () => {
    assert.strictEqual(encodeHexKeys(""), "");
  });
});

describe("unescapeTmuxOutput", () => {
  it("unescapes CR LF", () => {
    assert.strictEqual(unescapeTmuxOutput("hello\\015\\012"), "hello\r\n");
  });

  it("unescapes backslash", () => {
    assert.strictEqual(unescapeTmuxOutput("a\\134b"), "a\\b");
  });

  it("preserves plain text", () => {
    assert.strictEqual(unescapeTmuxOutput("hello world"), "hello world");
  });

  it("unescapes mixed content", () => {
    assert.strictEqual(unescapeTmuxOutput("$ ls\\015\\012"), "$ ls\r\n");
  });

  it("preserves partial octal sequences", () => {
    assert.strictEqual(unescapeTmuxOutput("a\\01z"), "a\\01z");
  });

  it("rejects non-octal digits", () => {
    assert.strictEqual(unescapeTmuxOutput("a\\189"), "a\\189");
  });
});

describe("stripDaResponses", () => {
  it("strips DA1 response", () => {
    assert.strictEqual(stripDaResponses("\x1b[?1;2c"), "");
  });

  it("strips DA2 response", () => {
    assert.strictEqual(stripDaResponses("\x1b[>0;276;0c"), "");
  });

  it("strips DA mixed with text", () => {
    assert.strictEqual(stripDaResponses("hello\x1b[?1;2cworld"), "helloworld");
  });

  it("preserves normal input", () => {
    assert.strictEqual(stripDaResponses("ls -la\r\n"), "ls -la\r\n");
  });

  it("preserves ctrl-b", () => {
    assert.strictEqual(stripDaResponses("\x02"), "\x02");
  });

  it("preserves other CSI sequences", () => {
    assert.strictEqual(stripDaResponses("\x1b[1;3H"), "\x1b[1;3H");
  });

  it("strips extended DA response", () => {
    assert.strictEqual(stripDaResponses("\x1b[?64;1;2;6;9;15;16;17;18;21;22c"), "");
  });

  it("preserves CSI with question prefix but non-DA final byte", () => {
    // ESC[?25h (show cursor) — NOT a DA response
    assert.strictEqual(stripDaResponses("\x1b[?25h"), "\x1b[?25h");
  });

  it("preserves alt screen sequence", () => {
    // ESC[?1049h (alt screen) — NOT a DA response
    assert.strictEqual(stripDaResponses("\x1b[?1049h"), "\x1b[?1049h");
  });

  it("strips CPR response (cursor position report)", () => {
    // ESC[35;1R — response to DSR 6 (ESC[6n)
    assert.strictEqual(stripDaResponses("\x1b[35;1R"), "");
  });

  it("strips CPR mixed with text", () => {
    assert.strictEqual(stripDaResponses("hello\x1b[25;80Rworld"), "helloworld");
  });

  it("strips CPR with large row/col values", () => {
    assert.strictEqual(stripDaResponses("\x1b[999;999R"), "");
  });

  it("preserves CSI sequences ending in R without semicolon (not CPR)", () => {
    // ESC[1R is a scroll-down sequence, not a CPR (no semicolon)
    assert.strictEqual(stripDaResponses("\x1b[1R"), "\x1b[1R");
  });

  it("strips both DA and CPR in same input", () => {
    assert.strictEqual(stripDaResponses("\x1b[?1;2c\x1b[35;1R"), "");
  });

  it("preserves cursor movement sequences (ESC[row;colH)", () => {
    // ESC[1;3H (cursor position) — NOT a CPR
    assert.strictEqual(stripDaResponses("\x1b[1;3H"), "\x1b[1;3H");
  });
});

// --- RingBuffer tests ---

describe("RingBuffer", () => {
  it("initializes with default limits", () => {
    const buf = new RingBuffer();
    assert.strictEqual(buf.maxItems, 5000);
    assert.strictEqual(buf.maxBytes, 5 * 1024 * 1024);
  });

  it("initializes with custom limits", () => {
    const buf = new RingBuffer(100, 1024);
    assert.strictEqual(buf.maxItems, 100);
    assert.strictEqual(buf.maxBytes, 1024);
  });

  it("pushes and retrieves data", () => {
    const buf = new RingBuffer();
    buf.push("hello");
    buf.push(" world");
    assert.strictEqual(buf.toString(), "hello world");
  });

  it("evicts when item limit exceeded", () => {
    const buf = new RingBuffer(3, 10000);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    assert.strictEqual(buf.toString(), "bcd");
  });

  it("reports stats", () => {
    const buf = new RingBuffer();
    buf.push("hello");
    const stats = buf.stats();
    assert.strictEqual(stats.items, 1);
    assert.strictEqual(stats.bytes, 5);
  });

  it("clears all data", () => {
    const buf = new RingBuffer();
    buf.push("test");
    buf.clear();
    assert.strictEqual(buf.toString(), "");
    assert.strictEqual(buf.stats().items, 0);
    assert.strictEqual(buf.stats().bytes, 0);
  });
});

// --- Session tests (using mock control mode) ---

// MockControlProc simulates the tmux -C attach-session child process
class MockControlProc {
  constructor() {
    this.stdin = new MockWritable();
    this.stdout = new MockReadable();
    this.killed = false;
    this._closeHandlers = [];
    this._errorHandlers = [];
  }

  on(event, handler) {
    if (event === "close") this._closeHandlers.push(handler);
    if (event === "error") this._errorHandlers.push(handler);
  }

  kill() {
    this.killed = true;
  }

  // Test helper: simulate tmux control mode %output line
  simulateOutput(paneId, data) {
    // Escape the data like tmux would (simple: just replace \r and \n)
    const escaped = data
      .replace(/\\/g, "\\134")
      .replace(/\r/g, "\\015")
      .replace(/\n/g, "\\012");
    this.stdout._emit(`%output ${paneId} ${escaped}\n`);
  }

  // Test helper: simulate raw data on stdout (pre-formatted)
  simulateRawStdout(data) {
    this.stdout._emit(data);
  }

  // Test helper: simulate process exit
  simulateClose(code = 0) {
    for (const handler of this._closeHandlers) handler(code);
  }
}

class MockWritable {
  constructor() {
    this.written = [];
    this.writable = true;
    this.ended = false;
  }
  write(data) { this.written.push(data); }
  end() { this.ended = true; this.writable = false; }
}

class MockReadable {
  constructor() {
    this._handlers = [];
  }
  on(event, handler) {
    if (event === "data") this._handlers.push(handler);
  }
  _emit(data) {
    for (const handler of this._handlers) handler(Buffer.from(data));
  }
}

function createSimpleTestSession(name, options = {}) {
  const tmuxName = tmuxSessionName(name);
  const session = new Session(name, tmuxName, options);
  const mockProc = new MockControlProc();
  session.controlProc = mockProc;
  session.alive = true;

  mockProc.on("close", (code) => {
    if (session.alive) {
      session.alive = false;
      if (session._onExit) session._onExit(session.name, code ?? 0);
    }
  });

  return { session, mockProc };
}

describe("Session", () => {
  describe("constructor", () => {
    it("creates a session with name and tmux name", () => {
      const session = new Session("test", "test");
      assert.strictEqual(session.name, "test");
      assert.strictEqual(session.tmuxName, "test");
      assert.strictEqual(session.alive, true);
    });

    it("initializes output buffer with default limits", () => {
      const session = new Session("test", "test");
      assert.ok(session.outputBuffer);
      assert.strictEqual(session.outputBuffer.maxItems, 5000);
      assert.strictEqual(session.outputBuffer.maxBytes, 5 * 1024 * 1024);
    });

    it("initializes output buffer with custom limits", () => {
      const session = new Session("test", "test", {
        maxBufferItems: 100,
        maxBufferBytes: 1024,
      });
      assert.strictEqual(session.outputBuffer.maxItems, 100);
      assert.strictEqual(session.outputBuffer.maxBytes, 1024);
    });
  });

  describe("write", () => {
    it("sends hex-encoded data via control mode", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session.write("ls\n");

      // Should have sent a send-keys -H command
      assert.strictEqual(mockProc.stdin.written.length, 1);
      const cmd = mockProc.stdin.written[0];
      assert.ok(cmd.startsWith("send-keys -H "));
      assert.ok(cmd.endsWith("\n"));
      // "ls\n" = 6c 73 0a
      assert.ok(cmd.includes("6c 73 0a"));
    });

    it("throws SessionNotAliveError when session is dead", () => {
      const { session } = createSimpleTestSession("test");
      session.alive = false;

      assert.throws(
        () => session.write("test"),
        (err) => {
          assert(err instanceof SessionNotAliveError);
          assert.strictEqual(err.sessionName, "test");
          return true;
        }
      );
    });

    it("strips DA responses from input", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      // DA1 response only — should result in nothing sent
      session.write("\x1b[?1;2c");

      assert.strictEqual(mockProc.stdin.written.length, 0);
    });

    it("allows multiple writes", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session.write("command1\n");
      session.write("command2\n");
      session.write("command3\n");

      assert.strictEqual(mockProc.stdin.written.length, 3);
    });
  });

  describe("resize", () => {
    it("sends refresh-client command via control mode", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session.resize(80, 24);

      assert.ok(mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 80x24")
      ));
    });

    it("does not resize when session is dead", () => {
      const { session, mockProc } = createSimpleTestSession("test");
      session.alive = false;

      session.resize(80, 24);

      assert.strictEqual(mockProc.stdin.written.length, 0);
    });
  });

  describe("kill", () => {
    it("marks session as not alive", () => {
      const { session } = createSimpleTestSession("test");

      session.kill();

      assert.strictEqual(session.alive, false);
    });

    it("is idempotent (safe to call multiple times)", () => {
      const { session } = createSimpleTestSession("test");

      session.kill();
      session.kill();
      session.kill();

      assert.strictEqual(session.alive, false);
    });

    it("closes control mode stdin", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session.kill();

      assert.strictEqual(mockProc.stdin.ended, true);
    });
  });

  describe("control mode exit handling", () => {
    it("marks session as not alive on control process exit", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      assert.strictEqual(session.alive, true);
      mockProc.simulateClose(0);
      assert.strictEqual(session.alive, false);
    });

    it("calls onExit callback when control process exits", () => {
      const exitEvents = [];
      const { session, mockProc } = createSimpleTestSession("test", {
        onExit: (name, exitCode) => exitEvents.push({ name, exitCode }),
      });

      mockProc.simulateClose(1);

      assert.strictEqual(exitEvents.length, 1);
      assert.strictEqual(exitEvents[0].name, "test");
      assert.strictEqual(exitEvents[0].exitCode, 1);
    });
  });

  describe("output via control mode", () => {
    it("parses %output lines and buffers data", () => {
      const { session, mockProc } = createSimpleTestSession("test");
      // Manually push data to simulate output parsing
      const data = "Hello World";
      session.outputBuffer.push(data);

      assert.strictEqual(session.getBuffer(), "Hello World");
    });

    it("calls onData callback", () => {
      const dataEvents = [];
      const { session } = createSimpleTestSession("test", {
        onData: (name, data) => dataEvents.push({ name, data }),
      });

      // Simulate what the control mode parser does
      const data = "test output";
      session.outputBuffer.push(data);
      session._onData("test", data);

      assert.strictEqual(dataEvents.length, 1);
      assert.strictEqual(dataEvents[0].name, "test");
      assert.strictEqual(dataEvents[0].data, "test output");
    });
  });

  describe("getBuffer", () => {
    it("returns empty string for new session", () => {
      const { session } = createSimpleTestSession("test");
      assert.strictEqual(session.getBuffer(), "");
    });

    it("returns buffered output", () => {
      const { session } = createSimpleTestSession("test");
      session.outputBuffer.push("$ ls\n");
      session.outputBuffer.push("file1.txt\n");

      assert.strictEqual(session.getBuffer(), "$ ls\nfile1.txt\n");
    });

    it("returns buffer even after session dies", () => {
      const { session, mockProc } = createSimpleTestSession("test");
      session.outputBuffer.push("output before exit\n");
      mockProc.simulateClose(0);

      assert.strictEqual(session.getBuffer(), "output before exit\n");
    });
  });

  describe("clearBuffer", () => {
    it("clears the output buffer", () => {
      const { session } = createSimpleTestSession("test");
      session.outputBuffer.push("test data");
      assert.strictEqual(session.getBuffer(), "test data");

      session.clearBuffer();
      assert.strictEqual(session.getBuffer(), "");
    });
  });

  describe("stats", () => {
    it("returns session statistics", () => {
      const { session } = createSimpleTestSession("my-session");
      session.outputBuffer.push("hello");

      const stats = session.stats();
      assert.strictEqual(stats.name, "my-session");
      assert.strictEqual(stats.tmuxSession, "my-session");
      assert.strictEqual(stats.alive, true);
      assert.strictEqual(stats.buffer.items, 1);
      assert.strictEqual(stats.buffer.bytes, 5);
    });

    it("reflects dead status after exit", () => {
      const { session, mockProc } = createSimpleTestSession("test");
      mockProc.simulateClose(1);

      const stats = session.stats();
      assert.strictEqual(stats.alive, false);
    });
  });

  describe("toJSON", () => {
    it("serializes to JSON with name, tmuxSession, alive, hasChildProcesses", () => {
      const { session } = createSimpleTestSession("test");

      const json = session.toJSON();
      assert.strictEqual(json.name, "test");
      assert.strictEqual(json.tmuxSession, "test");
      assert.strictEqual(json.alive, true);
      assert.strictEqual(typeof json.hasChildProcesses, "boolean");
    });

    it("works with JSON.stringify", () => {
      const { session } = createSimpleTestSession("test");

      const json = JSON.stringify(session);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.name, "test");
      assert.strictEqual(parsed.tmuxSession, "test");
      assert.strictEqual(parsed.alive, true);
      assert.strictEqual(typeof parsed.hasChildProcesses, "boolean");
    });
  });

  describe("hasChildProcesses", () => {
    it("returns false for dead session", () => {
      const { session } = createSimpleTestSession("test");
      session.alive = false;
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns false when lastKnownChildCount is 0", () => {
      const { session } = createSimpleTestSession("test");
      session.lastKnownChildCount = 0;
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns false when lastKnownChildCount is 1", () => {
      const { session } = createSimpleTestSession("test");
      session.lastKnownChildCount = 1;
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns true when lastKnownChildCount > 1", () => {
      const { session } = createSimpleTestSession("test");
      session.lastKnownChildCount = 2;
      assert.strictEqual(session.hasChildProcesses(), true);
    });
  });

  describe("buffer overflow handling", () => {
    it("respects buffer limits", () => {
      const { session } = createSimpleTestSession("test", {
        maxBufferItems: 3,
        maxBufferBytes: 100,
      });

      session.outputBuffer.push("line1\n");
      session.outputBuffer.push("line2\n");
      session.outputBuffer.push("line3\n");
      session.outputBuffer.push("line4\n"); // Should evict line1

      const buffer = session.getBuffer();
      assert.ok(!buffer.includes("line1"));
      assert.ok(buffer.includes("line2"));
      assert.ok(buffer.includes("line3"));
      assert.ok(buffer.includes("line4"));
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
