import { describe, it } from "node:test";
import assert from "node:assert";
import { Buffer } from "node:buffer";
import { Session, SessionNotAliveError } from "../lib/session.js";
import { RingBuffer } from "../lib/ring-buffer.js";
import {
  tmuxSessionName, encodeHexKeys, unescapeTmuxOutputBytes, stripDaResponses,
} from "../lib/tmux.js";

/**
 * Test-local per-line wrapper around `unescapeTmuxOutputBytes`. Exercises
 * the single-line behaviour (no carry plumbing) that the unit tests below
 * assert on. Production callers must use `unescapeTmuxOutputBytes` directly
 * and maintain a carry across %output boundaries — Session does this.
 *
 * A trailing partial octal escape (e.g. `…\34`) is returned as literal
 * bytes here to match the pre-carry behaviour the unit tests document.
 */
function unescapeTmuxOutput(s) {
  const { bytes, carry } = unescapeTmuxOutputBytes(s);
  if (!carry) return bytes.toString("utf-8");
  return Buffer.concat([bytes, Buffer.from(carry, "utf-8")]).toString("utf-8");
}

// --- tmux control mode helper tests ---

describe("tmuxSessionName", () => {
  it("replaces tmux-incompatible characters with underscores", () => {
    assert.strictEqual(tmuxSessionName("my.session"), "my_session");
    assert.strictEqual(tmuxSessionName("host:port"), "host_port");
    assert.strictEqual(tmuxSessionName("a.b:c"), "a_b_c");
    assert.strictEqual(tmuxSessionName("my session"), "my_session");
    assert.strictEqual(tmuxSessionName("a.b c:d"), "a_b_c_d");
    assert.strictEqual(tmuxSessionName("test #1"), "test__1");
    assert.strictEqual(tmuxSessionName("50%"), "50_");
  });

  it("preserves other printable ASCII", () => {
    assert.strictEqual(tmuxSessionName("default"), "default");
    assert.strictEqual(tmuxSessionName("my-session"), "my-session");
    assert.strictEqual(tmuxSessionName("test!@$&"), "test!@$&");
    assert.strictEqual(tmuxSessionName("(prod)"), "(prod)");
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

  it("decodes octal-escaped emoji (👋) as UTF-8 bytes", () => {
    // 👋 = U+1F44B = UTF-8 bytes F0 9F 91 8B = octal \360\237\221\213
    assert.strictEqual(unescapeTmuxOutput("\\360\\237\\221\\213"), "👋");
  });

  it("decodes octal-escaped CJK (你好) as UTF-8 bytes", () => {
    // 你 = E4 BD A0, 好 = E5 A5 BD
    assert.strictEqual(unescapeTmuxOutput("\\344\\275\\240\\345\\245\\275"), "你好");
  });

  it("decodes mixed ASCII and octal-escaped emoji", () => {
    assert.strictEqual(
      unescapeTmuxOutput("hello \\360\\237\\221\\213 world"),
      "hello 👋 world"
    );
  });

  it("handles passthrough UTF-8 (tmux -u mode) without escaping", () => {
    // When tmux passes high bytes through directly (not octal-escaped)
    assert.strictEqual(unescapeTmuxOutput("hello 👋 world"), "hello 👋 world");
  });

  it("handles passthrough emoji above BMP via surrogate pairs", () => {
    assert.strictEqual(unescapeTmuxOutput("hi \uD83D\uDC4B bye"), "hi 👋 bye");
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
    assert.strictEqual(buf.maxBytes, 20 * 1024 * 1024);
  });

  it("initializes with custom byte limit", () => {
    const buf = new RingBuffer(1024);
    assert.strictEqual(buf.maxBytes, 1024);
  });

  it("pushes and retrieves data", () => {
    const buf = new RingBuffer();
    buf.push("hello");
    buf.push(" world");
    assert.strictEqual(buf.toString(), "hello world");
  });

  it("evicts when byte limit exceeded", () => {
    const buf = new RingBuffer(3);
    buf.push("ab");   // 2 bytes
    buf.push("cd");   // 2 bytes, total 4 -> evict "ab", leaves 2
    buf.push("ef");   // 2 bytes, total 4 -> evict "cd", leaves 2
    assert.strictEqual(buf.toString(), "ef");
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

  once(event, handler) {
    // Wrap so the handler fires at most once and then detaches itself,
    // matching Node's EventEmitter.once semantics. The real controlProc
    // is a ChildProcess, which is an EventEmitter with once() support.
    const wrapper = (...args) => {
      const list = event === "close" ? this._closeHandlers : this._errorHandlers;
      const i = list.indexOf(wrapper);
      if (i !== -1) list.splice(i, 1);
      handler(...args);
    };
    this.on(event, wrapper);
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

  // Test helper: simulate process exit. Iterates a copy so a `once`
  // handler that self-removes during dispatch doesn't break iteration.
  simulateClose(code = 0) {
    for (const handler of [...this._closeHandlers]) handler(code);
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
  session.state = Session.STATE_ATTACHED;

  mockProc.on("close", (code) => {
    if (session.state === Session.STATE_ATTACHED) {
      session.state = Session.STATE_DETACHED;
      if (session._onExit) session._onExit(session.name, code ?? 0);
    }
  });

  return { session, mockProc };
}

/**
 * Create a test session with the stdout output parser wired up,
 * so simulateOutput() goes through the real %output parsing + coalescing path.
 */
function createWiredTestSession(name, options = {}) {
  const { session, mockProc } = createSimpleTestSession(name, options);

  // Wire up the real _handleStdoutData method (same path as attachControlMode)
  mockProc.stdout.on("data", (chunk) => session._handleStdoutData(chunk));

  return { session, mockProc };
}

describe("Session", () => {
  describe("constructor", () => {
    it("creates a session with name and tmux name", () => {
      const session = new Session("test", "test");
      assert.strictEqual(session.name, "test");
      assert.strictEqual(session.tmuxName, "test");
      assert.strictEqual(session.alive, false, "starts detached until attachControlMode is called");
    });

    it("initializes output buffer with default limits", () => {
      const session = new Session("test", "test");
      assert.ok(session.outputBuffer);
      assert.strictEqual(session.outputBuffer.maxBytes, 20 * 1024 * 1024);
    });

    it("initializes output buffer with custom byte limit", () => {
      const session = new Session("test", "test", {
        maxBufferBytes: 1024,
      });
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
      session.state = Session.STATE_DETACHED;

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

      // Mark output idle so the resize gate doesn't defer the call.
      // _lastOutputAt is initialized to Date.now() in the constructor
      // (see Tier 1.4 fix) so the gate fires for the very first resize
      // exactly as it would for any later one.
      session._lastOutputAt = Date.now() - 1000;
      session.resize(80, 24);

      assert.ok(mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 80x24")
      ));
    });

    it("does not resize when session is dead", () => {
      const { session, mockProc } = createSimpleTestSession("test");
      session.state = Session.STATE_DETACHED;

      session.resize(80, 24);

      assert.strictEqual(mockProc.stdin.written.length, 0);
    });

    it("defers resize when output was recently received", async () => {
      const { session, mockProc } = createSimpleTestSession("test");

      // Simulate recent output
      session._lastOutputAt = Date.now();

      session.resize(100, 40);

      // Should NOT have sent the command yet (gated)
      assert.ok(!mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "resize should be deferred during active output");

      // Wait for the gate to expire
      await new Promise((r) => setTimeout(r, 60));

      assert.ok(mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "deferred resize should fire after output settles");
    });

    it("coalesces multiple deferred resizes to the latest dimensions", async () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session._lastOutputAt = Date.now();

      session.resize(100, 30);
      session.resize(100, 35);
      session.resize(100, 40);

      await new Promise((r) => setTimeout(r, 60));

      // Only the last dimensions should have been applied
      const resizeCmds = mockProc.stdin.written.filter(cmd =>
        cmd.includes("refresh-client")
      );
      assert.strictEqual(resizeCmds.length, 1);
      assert.ok(resizeCmds[0].includes("100x40"));
    });

    it("resizes immediately when output is idle", () => {
      const { session, mockProc } = createSimpleTestSession("test");

      // Simulate idle session: _lastOutputAt was 1s ago, well past the
      // 50ms gate. Constructor seeds it to now() so we set it explicitly.
      session._lastOutputAt = Date.now() - 1000;
      session.resize(100, 40);

      assert.ok(mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "should resize immediately when no recent output");
    });

    it("re-defers when output keeps arriving during gate", async () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session._lastOutputAt = Date.now();
      session.resize(100, 40);

      // Simulate output arriving 30ms later (still within gate)
      await new Promise((r) => setTimeout(r, 30));
      session._lastOutputAt = Date.now();

      // At 60ms the first timer would have fired, but it re-enters
      // resize() which re-defers because _lastOutputAt is fresh
      await new Promise((r) => setTimeout(r, 35));
      assert.ok(!mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "should still be deferred while output is active");

      // Wait for the re-deferred timer to fire (output now idle)
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "should fire after output stops");
    });

    it("cancels resize timer on session kill", async () => {
      const { session, mockProc } = createSimpleTestSession("test");

      session._lastOutputAt = Date.now();
      session.resize(100, 40);

      // Kill before the timer fires
      session.kill();

      await new Promise((r) => setTimeout(r, 60));
      assert.ok(!mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "killed session should not send deferred resize");
    });

    it("does not reset RESIZE_MAX_DEFER_MS deadline on recursive defer (regression)", () => {
      // Past bug: the deadline was set inside `if (!_resizeTimer)`. The
      // recursive timer callback nulls _resizeTimer before re-entering
      // resize(), so every re-entry hit the guard and reset the deadline.
      // The "absolute 500ms cap" became a sliding window that never
      // expired — for `tail -f`-style continuous output, resize was
      // deferred forever and TUI apps garbled on rotate/keyboard-open.
      const { session } = createSimpleTestSession("test");

      session._lastOutputAt = Date.now();
      session.resize(100, 40);
      const firstDeadline = session._resizeDeadline;
      assert.ok(firstDeadline > 0, "first defer should set the deadline");

      // Simulate the timer firing internally (the recursive callback
      // clears _resizeTimer and re-enters resize) several times in
      // succession, with output still arriving each time.
      for (let i = 0; i < 5; i++) {
        clearTimeout(session._resizeTimer);
        session._resizeTimer = null;
        session._lastOutputAt = Date.now();
        session.resize(100, 40);
      }

      assert.strictEqual(session._resizeDeadline, firstDeadline,
        "_resizeDeadline must not reset on recursive resize re-entry — " +
        "the cap is supposed to be absolute, not sliding"
      );

      // Cleanup
      clearTimeout(session._resizeTimer);
      session._resizeTimer = null;
    });

    it("applies deferred resize after RESIZE_MAX_DEFER_MS even with continuous output", async () => {
      // End-to-end safety net for the absolute cap. Without the fix this
      // test hangs (or fails) because the bumper interval keeps pushing
      // _lastOutputAt forward and the buggy "deadline reset" defers
      // forever. With the fix the cap fires at ~500ms.
      const { session, mockProc } = createSimpleTestSession("test");

      session._lastOutputAt = Date.now();
      session.resize(100, 40);

      // Bump _lastOutputAt every 20ms for 600ms — simulating a session
      // that never goes idle (e.g. `tail -f`).
      const bumper = setInterval(() => {
        session._lastOutputAt = Date.now();
      }, 20);

      try {
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        clearInterval(bumper);
      }

      const resizeCmds = mockProc.stdin.written.filter(cmd =>
        cmd.includes("refresh-client -C 100x40")
      );
      assert.ok(resizeCmds.length >= 1,
        "deferred resize must apply after RESIZE_MAX_DEFER_MS even when output never idles");
    });

    it("first resize after construction is gated by initial _lastOutputAt (regression)", () => {
      // Past bug: _lastOutputAt = 0 in the constructor meant the very
      // first resize saw sinceLast = Date.now() (a huge number) and fired
      // refresh-client immediately. If tmux had startup output queued on
      // stdout that hadn't been parsed yet, the resize raced it and
      // garbled the first frame on session birth.
      const { session, mockProc } = createSimpleTestSession("test");

      // Do not touch _lastOutputAt — the constructor seeds it to now().
      session.resize(100, 40);

      // The resize should be deferred (the gate is active for the first call too)
      assert.ok(!mockProc.stdin.written.some(cmd =>
        cmd.includes("refresh-client -C 100x40")
      ), "first resize should be gated, not fire immediately");

      // Cleanup
      if (session._resizeTimer) {
        clearTimeout(session._resizeTimer);
        session._resizeTimer = null;
      }
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

    it("sends in-band detach-client instead of SIGTERM (avoids tmux 3.6a UAF)", () => {
      // Regression: prior implementation sent SIGTERM via proc.kill(),
      // which tripped a use-after-free in tmux 3.6a's
      // control_notify_client_detached path. The fix is to walk tmux's
      // clean detach path via an in-band `detach-client` command.
      const { session, mockProc } = createSimpleTestSession("test");

      session.kill();

      assert.ok(
        mockProc.stdin.written.includes("detach-client\n"),
        "should write detach-client to control mode stdin"
      );
      assert.strictEqual(mockProc.stdin.ended, true, "should end stdin after detach-client");
      assert.strictEqual(mockProc.killed, false, "should NOT SIGTERM the child — that triggers tmux UAF");
    });

    it("defers tmux kill-session until after the control client has exited", () => {
      // Regression: kill() used to invoke tmuxKillSession synchronously
      // while the control client was still attached. Destroying the
      // session with a live control client trips the same UAF path.
      // Now kill() first detaches in-band, waits for the control proc
      // to close, THEN runs kill-session.
      //
      // We inject a spy for tmuxKillSession so we can observe the exact
      // order: detach-client must be written FIRST, the close event
      // must fire NEXT, and only then is kill-session invoked.
      const callLog = [];
      const { session, mockProc } = createSimpleTestSession("test", {
        _tmuxKillSession: async (name) => { callLog.push(`kill-session:${name}`); },
      });
      // Spy on the stdin write so we can record the detach-client event
      // inline with kill-session in a single call log. MockWritable.write
      // doesn't use `this`, so a plain reassignment is enough.
      const originalWrite = mockProc.stdin.write;
      mockProc.stdin.write = (data) => {
        if (data === "detach-client\n") callLog.push("detach-client");
        return originalWrite.call(mockProc.stdin, data);
      };

      session.kill();

      // Before the child closes, detach-client must have been written
      // and kill-session must NOT have run yet.
      assert.deepStrictEqual(callLog, ["detach-client"],
        "kill-session must not run before the control client closes");
      assert.strictEqual(mockProc.stdin.ended, true);

      // Now simulate the child closing; kill-session should fire.
      mockProc.simulateClose(0);
      assert.deepStrictEqual(callLog, ["detach-client", `kill-session:${tmuxSessionName("test")}`],
        "kill-session must run only after the close event");
    });
  });

  describe("detach", () => {
    it("sends in-band detach-client instead of SIGTERM (avoids tmux 3.6a UAF)", () => {
      // Same regression as kill(): detach() tears down the control
      // client but leaves the tmux session alive. It must still use
      // the in-band detach path — sending SIGTERM to a `tmux -C`
      // child trips the UAF even when kill-session is never called.
      const { session, mockProc } = createSimpleTestSession("test");

      session.detach();

      assert.ok(
        mockProc.stdin.written.includes("detach-client\n"),
        "should write detach-client to control mode stdin"
      );
      assert.strictEqual(mockProc.stdin.ended, true, "should end stdin after detach-client");
      assert.strictEqual(mockProc.killed, false, "should NOT SIGTERM the child — that triggers tmux UAF");
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
        onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
      });

      // Simulate what the control mode parser does
      const fromSeq = session.outputBuffer.totalBytes;
      session.outputBuffer.push("test output");
      session._onData("test", fromSeq);

      assert.strictEqual(dataEvents.length, 1);
      assert.strictEqual(dataEvents[0].name, "test");
      assert.strictEqual(dataEvents[0].fromSeq, 0);
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
      session.state = Session.STATE_DETACHED;
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns false when child count is 0", () => {
      const { session } = createSimpleTestSession("test");
      session.updateChildCount(0);
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns false when child count is 1", () => {
      const { session } = createSimpleTestSession("test");
      session.updateChildCount(1);
      assert.strictEqual(session.hasChildProcesses(), false);
    });

    it("returns true when child count > 1", () => {
      const { session } = createSimpleTestSession("test");
      session.updateChildCount(2);
      assert.strictEqual(session.hasChildProcesses(), true);
    });
  });

  describe("buffer overflow handling", () => {
    it("respects byte limit", () => {
      const { session } = createSimpleTestSession("test", {
        maxBufferBytes: 18,  // fits 3 lines of 6 bytes each
      });

      session.outputBuffer.push("line1\n");  // 6 bytes
      session.outputBuffer.push("line2\n");  // 6 bytes, total 12
      session.outputBuffer.push("line3\n");  // 6 bytes, total 18
      session.outputBuffer.push("line4\n");  // 6 bytes, total 24 -> evict "line1\n", leaves 18

      const buffer = session.getBuffer();
      assert.ok(!buffer.includes("line1"));
      assert.ok(buffer.includes("line2"));
      assert.ok(buffer.includes("line3"));
      assert.ok(buffer.includes("line4"));
    });
  });
});

describe("output dispatch", () => {
  it("dispatches onData synchronously for each %output line", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateOutput("%0", "hello");
    assert.strictEqual(dataEvents.length, 1);
    assert.strictEqual(dataEvents[0].fromSeq, 0);
  });

  it("dispatches each output chunk individually", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateOutput("%0", "aaa");
    mockProc.simulateOutput("%0", "bbb");
    mockProc.simulateOutput("%0", "ccc");

    assert.strictEqual(dataEvents.length, 3);
    assert.strictEqual(dataEvents[0].fromSeq, 0);
    assert.strictEqual(dataEvents[1].fromSeq, 3);
    assert.strictEqual(dataEvents[2].fromSeq, 6);
  });

  it("preserves individual chunks in the RingBuffer", () => {
    const { session, mockProc } = createWiredTestSession("test", {
      onData: () => {},
    });

    mockProc.simulateOutput("%0", "aaa");
    mockProc.simulateOutput("%0", "bbb");

    assert.strictEqual(session.outputBuffer.items.length, 2);
    assert.strictEqual(session.getBuffer(), "aaabbb");
  });

  it("does not dispatch after detach", () => {
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateOutput("%0", "before");
    assert.strictEqual(dataEvents.length, 1);

    session.detach();
    mockProc.simulateOutput("%0", "after");
    assert.strictEqual(dataEvents.length, 1);
  });

  it("does not dispatch after kill", () => {
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateOutput("%0", "before");
    session.kill();
    mockProc.simulateOutput("%0", "after");
    assert.strictEqual(dataEvents.length, 1);
  });

  it("dispatches on process close for decoder tail", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateOutput("%0", "data");
    mockProc.simulateClose(0);
    assert.strictEqual(dataEvents.length, 1);
    assert.strictEqual(dataEvents[0].fromSeq, 0);
  });

  it("drains _outputDecoder partial UTF-8 on detach (regression)", () => {
    // Past bug: detach() went through _closeControlProc which nulled
    // controlProc before the close handler could fire, so the
    // `this.controlProc !== proc` guard skipped the decoder drain.
    // Worse, _outputDecoder.end() was never called anywhere — partial
    // multi-byte UTF-8 buffered inside it (e.g. the first 2 bytes of
    // a 4-byte emoji) were silently dropped on every detach/kill.
    // The fix drains both decoders synchronously inside _closeControlProc
    // before the headless is disposed and _onData is cleared.
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    // Feed first 2 bytes of a 4-byte UTF-8 emoji (👋 = F0 9F 91 8B).
    // unescapeTmuxOutputBytes returns [0xF0, 0x9F] and the inner
    // StringDecoder buffers them as an incomplete sequence — nothing
    // is pushed to the RingBuffer yet.
    mockProc.simulateRawStdout("%output %0 \\360\\237\n");
    assert.strictEqual(session.outputBuffer.totalBytes, 0,
      "incomplete UTF-8 should buffer in _outputDecoder, not the RingBuffer");
    assert.strictEqual(dataEvents.length, 0);

    session.detach();

    assert.ok(session.outputBuffer.totalBytes > 0,
      "detach must drain _outputDecoder tail into the RingBuffer");
    assert.ok(dataEvents.length >= 1,
      "drained bytes should fire onData notification before _onData is cleared");
  });

  it("drains parser state on kill (regression)", () => {
    // Same bug as above, on the kill path. kill() also goes through
    // _closeControlProc; the drain must run before the headless is
    // disposed.
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, fromSeq) => dataEvents.push({ name, fromSeq }),
    });

    mockProc.simulateRawStdout("%output %0 \\344\\275\n"); // first 2 bytes of 你 (E4 BD A0)
    assert.strictEqual(session.outputBuffer.totalBytes, 0);

    session.kill();

    assert.ok(session.outputBuffer.totalBytes > 0,
      "kill must drain _outputDecoder tail into the RingBuffer");
  });
});

describe("screenFingerprint seq tagging (regression)", () => {
  // Lamport's lesson: comparing two states requires they describe the
  // SAME logical time. The server's fingerprint must be paired with the
  // byte position it describes — otherwise the client compares a hash
  // taken at byte N to its own state at some other byte M and reports
  // false drift, triggering a spurious resync (the same garble symptom
  // we are trying to fix).
  //
  // These tests pin the contract: { hash, seq } shape, and seq matches
  // outputBuffer.totalBytes at the moment the hash was computed.

  it("returns { hash, seq } shape on a freshly attached session", async () => {
    const { session } = createWiredTestSession("test");
    const fp = await session.screenFingerprint();
    assert.strictEqual(typeof fp, "object",
      "must return an object so callers can pair the hash with a sequence number");
    assert.ok("hash" in fp, "must include hash field");
    assert.ok("seq" in fp, "must include seq field");
    assert.strictEqual(typeof fp.hash, "number");
    assert.strictEqual(typeof fp.seq, "number");
    assert.strictEqual(fp.seq, 0,
      "fresh session has not received any output, seq should be 0");
  });

  it("seq matches outputBuffer.totalBytes after data has been written", async () => {
    const { session, mockProc } = createWiredTestSession("test");
    mockProc.simulateOutput("%0", "hello world");
    // Wait one tick so the inner setImmediate flush completes.
    await new Promise(resolve => setImmediate(resolve));
    const fp = await session.screenFingerprint();
    assert.strictEqual(fp.seq, session.outputBuffer.totalBytes,
      "seq must equal the byte position the hash describes — anything else " +
      "lets the client compare hashes from different points in the stream");
    assert.ok(fp.seq > 0, "after writing data, seq should advance past 0");
  });

  it("returns { hash: 0, seq: 0 } when headless is disposed", async () => {
    const { session } = createWiredTestSession("test");
    session._screen.dispose();
    const fp = await session.screenFingerprint();
    assert.deepStrictEqual(fp, { hash: 0, seq: 0 },
      "disposed headless must still return the structured shape — " +
      "callers destructure { hash, seq }, not a bare number");
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

// --- seedScreen tests ---

describe("seedScreen", () => {
  it("writes captured pane content to headless terminal", async () => {
    const { session } = createWiredTestSession("seed-test", {
      onData: () => {},
    });

    await session.seedScreen("$ hello world\r\n$ ");

    const serialized = await session.serializeScreen();
    assert.ok(serialized.length > 0, "serialized screen should not be empty after seed");
    assert.ok(serialized.includes("hello world"), "serialized screen should contain seeded content");
  });

  it("positions cursor after seed content", async () => {
    const { session } = createWiredTestSession("seed-cursor", {
      onData: () => {},
    });

    await session.seedScreen("$ prompt here");

    // The screen mirror's cursor should be positioned after the seed text
    const { x, y } = session._screen.cursor;
    assert.ok(x > 0 || y > 0, "cursor should not be at origin after seed");
  });

  it("does not affect the RingBuffer", async () => {
    const { session } = createWiredTestSession("seed-no-ring", {
      onData: () => {},
    });

    await session.seedScreen("some pane content\r\n");

    assert.strictEqual(session.outputBuffer.totalBytes, 0, "RingBuffer should remain empty after seed");
    assert.strictEqual(session.getBuffer(), "", "getBuffer should return empty after seed");
  });

  it("no-ops when content is null", async () => {
    const { session } = createWiredTestSession("seed-null", {
      onData: () => {},
    });

    await session.seedScreen(null);

    const serialized = await session.serializeScreen();
    // Should be empty or minimal (no crash)
    assert.strictEqual(typeof serialized, "string");
  });

  it("no-ops when content is empty string", async () => {
    const { session } = createWiredTestSession("seed-empty", {
      onData: () => {},
    });

    await session.seedScreen("");

    // Should not crash
    const serialized = await session.serializeScreen();
    assert.strictEqual(typeof serialized, "string");
  });

  it("no-ops when headless terminal is disposed", async () => {
    const { session } = createWiredTestSession("seed-disposed", {
      onData: () => {},
    });

    session._screen.dispose();

    // Should not throw
    await session.seedScreen("some content");
  });

  it("is overwritten by subsequent %output data", async () => {
    const { session, mockProc } = createWiredTestSession("seed-overwrite", {
      onData: () => {},
    });

    // Seed with initial content
    await session.seedScreen("$ old prompt");

    // Now simulate real output arriving
    mockProc.simulateOutput("%0", "\x1b[H\x1b[2J$ new prompt");

    const serialized = await session.serializeScreen();
    assert.ok(serialized.includes("new prompt"), "real output should overwrite seed");
  });

  it("positions cursor correctly when cursorPos is provided", async () => {
    const { session } = createWiredTestSession("seed-cursor-pos", {
      onData: () => {},
    });

    // Seed with content and explicit cursor position (row 2, col 5 — 1-based)
    await session.seedScreen("line1\r\nline2\r\nline3", { row: 2, col: 5 });

    const { x, y } = session._screen.cursor;
    // cursor coords are 0-based; row/col are 1-based
    assert.strictEqual(y, 1, "cursor row should be 1 (0-based) for row:2");
    assert.strictEqual(x, 4, "cursor col should be 4 (0-based) for col:5");
  });
});
