import { describe, it } from "node:test";
import assert from "node:assert";
import { Buffer } from "node:buffer";
import { Session, SessionNotAliveError } from "../lib/session.js";
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

  // Wire up the real parser (same path as attachControlMode)
  mockProc.stdout.on("data", (chunk) => session._parser.write(chunk));

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

    it("exposes cols and rows via the screen mirror", () => {
      const session = new Session("test", "test");
      // ScreenState initializes to default dims (40x24 — see ScreenState
      // constructor) before any resize happens. Tests rely on these being
      // readable even before attach.
      assert.strictEqual(typeof session.cols, "number");
      assert.strictEqual(typeof session.rows, "number");
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
    it("invokes onData with the decoded payload for each %output line", () => {
      const dataEvents = [];
      const { mockProc } = createWiredTestSession("test", {
        onData: (name, payload) => dataEvents.push({ name, payload }),
      });

      mockProc.simulateOutput("%0", "hello");

      assert.strictEqual(dataEvents.length, 1);
      assert.strictEqual(dataEvents[0].name, "test");
      assert.strictEqual(dataEvents[0].payload, "hello");
    });
  });

  describe("stats", () => {
    it("returns session statistics including dims", () => {
      const { session } = createSimpleTestSession("my-session");

      const stats = session.stats();
      assert.strictEqual(stats.name, "my-session");
      assert.strictEqual(stats.tmuxSession, "my-session");
      assert.strictEqual(stats.alive, true);
      assert.strictEqual(typeof stats.cols, "number");
      assert.strictEqual(typeof stats.rows, "number");
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

});

describe("output dispatch", () => {
  it("dispatches onData synchronously for each %output line", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    mockProc.simulateOutput("%0", "hello");
    assert.strictEqual(dataEvents.length, 1);
    assert.strictEqual(dataEvents[0].payload, "hello");
  });

  it("dispatches each output chunk individually", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    mockProc.simulateOutput("%0", "aaa");
    mockProc.simulateOutput("%0", "bbb");
    mockProc.simulateOutput("%0", "ccc");

    assert.strictEqual(dataEvents.length, 3);
    assert.strictEqual(dataEvents[0].payload, "aaa");
    assert.strictEqual(dataEvents[1].payload, "bbb");
    assert.strictEqual(dataEvents[2].payload, "ccc");
  });

  it("does not dispatch after detach", () => {
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
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
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    mockProc.simulateOutput("%0", "before");
    session.kill();
    mockProc.simulateOutput("%0", "after");
    assert.strictEqual(dataEvents.length, 1);
  });

  it("dispatches on process close for decoder tail", () => {
    const dataEvents = [];
    const { mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    mockProc.simulateOutput("%0", "data");
    mockProc.simulateClose(0);
    assert.strictEqual(dataEvents.length, 1);
    assert.strictEqual(dataEvents[0].payload, "data");
  });

  it("drains parser partial UTF-8 on detach (regression)", () => {
    // Past bug: detach() went through _closeControlProc which nulled
    // controlProc before the close handler could fire, so the
    // `this.controlProc !== proc` guard skipped the decoder drain.
    // Worse, the parser's internal string decoder was never drained
    // anywhere — partial multi-byte UTF-8 buffered inside it (e.g. the
    // first 2 bytes of a 4-byte emoji) were silently dropped on every
    // detach/kill. The fix drains the parser synchronously inside
    // _closeControlProc before the screen is disposed and _onData is
    // cleared. Raptor 3 keeps the same drain path — only the observable
    // symptom has moved from "bytes missing in RingBuffer" to "bytes
    // missing in the onData callback stream".
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    // Feed first 2 bytes of a 4-byte UTF-8 emoji (👋 = F0 9F 91 8B).
    // The parser's internal StringDecoder buffers them as an incomplete
    // sequence — nothing is pushed to onData yet.
    mockProc.simulateRawStdout("%output %0 \\360\\237\n");
    assert.strictEqual(dataEvents.length, 0,
      "incomplete UTF-8 should buffer in the parser, not fire onData");

    session.detach();

    assert.ok(dataEvents.length >= 1,
      "detach must drain the parser's partial UTF-8 tail through onData " +
      "before _onData is cleared");
  });

  it("drains parser state on kill (regression)", () => {
    // Same bug as above, on the kill path. kill() also goes through
    // _closeControlProc; the drain must run before the screen mirror
    // is disposed.
    const dataEvents = [];
    const { session, mockProc } = createWiredTestSession("test", {
      onData: (name, payload) => dataEvents.push({ name, payload }),
    });

    mockProc.simulateRawStdout("%output %0 \\344\\275\n"); // first 2 bytes of 你 (E4 BD A0)
    assert.strictEqual(dataEvents.length, 0);

    session.kill();

    assert.ok(dataEvents.length >= 1,
      "kill must drain the parser's partial UTF-8 tail through onData");
  });
});

describe("Session.snapshot (Raptor 3)", () => {
  // Under Raptor 3, snapshot() is the single authoritative method that
  // converts the live ScreenState mirror into a client-facing tuple. The
  // contract:
  //
  //   - cols, rows — current dims of the ScreenState mirror (server owns dims)
  //   - data — serialized escape-sequence representation of the visible screen
  //   - alive — whether the session is still attached to tmux
  //
  // There is no sequence number, no pull cursor, and no byte-replay path.
  // Clients apply the snapshot atomically (resize → clear → write) and
  // then stream plain `output` messages that are guaranteed to be at the
  // same dims because any resize arrives as a new snapshot in-band.

  it("returns { cols, rows, data, alive } shape on a fresh session", async () => {
    const { session } = createWiredTestSession("snap");
    const snap = await session.snapshot();
    assert.strictEqual(typeof snap, "object");
    assert.ok("cols" in snap, "must include cols field");
    assert.ok("rows" in snap, "must include rows field");
    assert.ok("data" in snap, "must include data field");
    assert.ok("alive" in snap, "must include alive field");
    assert.strictEqual(typeof snap.cols, "number");
    assert.strictEqual(typeof snap.rows, "number");
    assert.strictEqual(typeof snap.data, "string");
    assert.strictEqual(typeof snap.alive, "boolean");
  });

  it("data reflects bytes written to the screen mirror before the snapshot", async () => {
    const { session, mockProc } = createWiredTestSession("snap");
    mockProc.simulateOutput("%0", "hello world");
    // Wait one tick so the parser's internal flush completes.
    await new Promise(resolve => setImmediate(resolve));
    const snap = await session.snapshot();
    assert.ok(snap.data.length > 0,
      "data should be non-empty after content has been written to the screen mirror");
  });

  it("cols and rows match the current ScreenState dims", async () => {
    const { session } = createWiredTestSession("snap");
    const snap = await session.snapshot();
    assert.strictEqual(snap.cols, session.cols);
    assert.strictEqual(snap.rows, session.rows);
  });

  it("returns empty data with current dims when not alive", async () => {
    const { session } = createWiredTestSession("snap");
    session.kill();
    const snap = await session.snapshot();
    assert.strictEqual(snap.alive, false);
    assert.strictEqual(snap.data, "");
    // cols/rows are still reported from the (now disposed) screen mirror
    assert.strictEqual(typeof snap.cols, "number");
    assert.strictEqual(typeof snap.rows, "number");
  });

  it("does not throw when the screen is disposed mid-snapshot", async () => {
    const { session } = createWiredTestSession("snap");
    // Simulate the race: screen is disposed before snapshot() finishes serializing
    session._screen.dispose();
    const snap = await session.snapshot();
    // Must return the structured shape, not throw
    assert.strictEqual(typeof snap.data, "string");
    assert.strictEqual(typeof snap.cols, "number");
    assert.strictEqual(typeof snap.rows, "number");
  });
});

describe("Session.onSnapshot (Raptor 3)", () => {
  // onSnapshot is the server-authoritative dim transition callback. It
  // fires from _applyResize after ScreenState has been resized and
  // re-serialized, so subscribers can transition their xterms atomically
  // (resize → clear → write) to the new dims.
  //
  // The callback payload is { session, cols, rows, data }. Callers must
  // flush pending %output BEFORE invoking resize() so the coalescer has
  // already drained old-dim bytes by the time onSnapshot fires.

  it("fires after a successful resize with the new dims", async () => {
    const events = [];
    const { session } = createSimpleTestSession("snap-resize", {
      onSnapshot: (evt) => events.push(evt),
    });

    // Mark output idle so the resize gate doesn't defer.
    session._lastOutputAt = Date.now() - 1000;
    await session.resize(120, 40);

    assert.strictEqual(events.length, 1, "onSnapshot should fire exactly once per resize");
    assert.strictEqual(events[0].session, "snap-resize");
    assert.strictEqual(events[0].cols, 120);
    assert.strictEqual(events[0].rows, 40);
    assert.strictEqual(typeof events[0].data, "string");
  });

  it("does not fire when the new dims match the current ones", async () => {
    const events = [];
    const { session } = createSimpleTestSession("snap-noop", {
      onSnapshot: (evt) => events.push(evt),
    });

    session._lastOutputAt = Date.now() - 1000;
    // First resize establishes the dims.
    await session.resize(100, 30);
    assert.strictEqual(events.length, 1, "first resize should fire onSnapshot");
    events.length = 0;

    // Second resize to the same dims should be a no-op.
    await session.resize(100, 30);
    assert.strictEqual(events.length, 0,
      "resize to identical dims must not fire onSnapshot (would cause needless repaints)");
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

    const { data } = await session.snapshot();
    assert.ok(data.length > 0, "snapshot data should not be empty after seed");
    assert.ok(data.includes("hello world"), "snapshot data should contain seeded content");
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

  it("no-ops when content is null", async () => {
    const { session } = createWiredTestSession("seed-null", {
      onData: () => {},
    });

    await session.seedScreen(null);

    const { data } = await session.snapshot();
    // Should be empty or minimal (no crash)
    assert.strictEqual(typeof data, "string");
  });

  it("no-ops when content is empty string", async () => {
    const { session } = createWiredTestSession("seed-empty", {
      onData: () => {},
    });

    await session.seedScreen("");

    // Should not crash
    const { data } = await session.snapshot();
    assert.strictEqual(typeof data, "string");
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

    const { data } = await session.snapshot();
    assert.ok(data.includes("new prompt"), "real output should overwrite seed");
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
