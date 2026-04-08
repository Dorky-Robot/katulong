/**
 * Tests for tmux %output partial-octal-escape splits.
 *
 * Regression: when running Claude Code inside a katulong session, the
 * colorful banner row at the top of the screen rendered as a long row of
 * yellow U+FFFD glyphs while the rest of the terminal looked perfect.
 *
 * Root cause: tmux control mode wraps each `%output` line at a length
 * limit. tmux escapes chars < ASCII 32 and `\` as three-digit octal
 * (`\NNN`), which is fine — but the wrap can fall *inside* a `\NNN`
 * escape. When that happens, line 1 ends with `…\34` and line 2 begins
 * with `2\226\210…`. If the unescape function processes each line
 * independently, the trailing `\34` is misparsed as a literal `\` `3` `4`
 * and the leading `2` of the next line desyncs every subsequent escape
 * on that line, producing a cascade of garbage bytes that the StringDecoder
 * converts to U+FFFD.
 *
 * This is much more likely than it sounds for output containing many
 * high-codepoint UTF-8 characters: each block char `█` (U+2588) is 3
 * UTF-8 bytes, and each byte is octal-escaped to 4 chars. A single
 * `█` therefore takes 12 chars in tmux's wire format. A row of 26
 * blocks is 312 chars; the odds of a chunk boundary falling outside
 * an escape are vanishingly small.
 *
 * The fix:
 *   - unescapeTmuxOutputBytes returns `{ bytes, carry }`. If the input
 *     ends mid-`\NNN`, the trailing 1-3 chars are returned as `carry`
 *     instead of being misparsed as literal bytes.
 *   - Session keeps `_octalCarry` across `%output` lines and prepends
 *     it to the next line's escaped data.
 *
 * Do NOT fix this by:
 *   - Trying to detect partial escapes in the StringDecoder layer — by
 *     the time bytes reach the decoder they are already garbage. The
 *     fix has to happen in the octal parser, before UTF-8 decoding.
 *   - Buffering whole %output lines until "complete" — there's no
 *     framing signal that says "this %output line is the last one for
 *     a logical chunk". Each %output line stands alone in tmux's
 *     protocol.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { unescapeTmuxOutputBytes, tmuxSessionName } from "../lib/tmux.js";
import { Session } from "../lib/session.js";

// --- Helpers ---

/**
 * Octal-escape a Buffer the way tmux control mode does: every byte
 * < ASCII 32 (and `\` itself) becomes a three-digit octal escape.
 *
 * `escapeHigh` defaults to `true` because we default-escape high bytes to
 * reproduce the observed production behaviour that triggered the bug —
 * tmux's live control-mode stream contained `\342\226\210` sequences for
 * the block character `█`, which is what the carry logic must survive.
 * Tests that want to simulate tmux's `-u` passthrough mode (high bytes
 * emitted literally) can pass `false`.
 */
function tmuxOctalEscape(buf, escapeHigh = true) {
  let out = "";
  for (const b of buf) {
    if (b < 32 || b === 0x5c || (escapeHigh && b >= 0x80)) {
      out += "\\" + b.toString(8).padStart(3, "0");
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

/**
 * Mock readable for the control mode stdout: lets a test fire arbitrary
 * raw chunks at session._parser.write() via the same code path used by
 * the real spawn().
 */
class MockReadable {
  constructor() { this._handlers = []; }
  on(event, handler) {
    if (event === "data") this._handlers.push(handler);
  }
  emit(data) {
    for (const h of this._handlers) h(Buffer.from(data));
  }
}

class MockProc {
  constructor() {
    this.stdin = { write() {}, end() {}, writable: true };
    this.stdout = new MockReadable();
    this._closeHandlers = [];
    this._errorHandlers = [];
  }
  on(event, handler) {
    if (event === "close") this._closeHandlers.push(handler);
    if (event === "error") this._errorHandlers.push(handler);
  }
  once(event, handler) {
    // Mirrors EventEmitter.once semantics — Session._closeControlProc
    // now uses proc.once("close"/"error") for the clean-detach path.
    const list = event === "close" ? this._closeHandlers : this._errorHandlers;
    const wrapper = (...args) => {
      const i = list.indexOf(wrapper);
      if (i !== -1) list.splice(i, 1);
      handler(...args);
    };
    list.push(wrapper);
  }
  fireClose(code = 0) {
    for (const h of [...this._closeHandlers]) h(code);
  }
  kill() {}
}

function createWiredSession(name) {
  const session = new Session(name, tmuxSessionName(name));
  const proc = new MockProc();
  session.controlProc = proc;
  session.state = Session.STATE_ATTACHED;
  proc.stdout.on("data", (chunk) => session._parser.write(chunk));
  return { session, proc };
}

// --- Unit tests for unescapeTmuxOutputBytes carry ---

describe("unescapeTmuxOutputBytes — partial escape carry", () => {
  it("returns empty carry when no partial escape is at the end", () => {
    const { bytes, carry } = unescapeTmuxOutputBytes("hello\\015");
    assert.equal(carry, "");
    assert.deepEqual([...bytes], [104, 101, 108, 108, 111, 13]);
  });

  it("defers a trailing '\\' as carry", () => {
    const { bytes, carry } = unescapeTmuxOutputBytes("hello\\");
    assert.equal(carry, "\\");
    assert.deepEqual([...bytes], [104, 101, 108, 108, 111]);
  });

  it("defers a trailing '\\N' as carry", () => {
    const { bytes, carry } = unescapeTmuxOutputBytes("hello\\3");
    assert.equal(carry, "\\3");
    assert.deepEqual([...bytes], [104, 101, 108, 108, 111]);
  });

  it("defers a trailing '\\NN' as carry", () => {
    const { bytes, carry } = unescapeTmuxOutputBytes("hello\\34");
    assert.equal(carry, "\\34");
    assert.deepEqual([...bytes], [104, 101, 108, 108, 111]);
  });

  it("consumes the carry when the next chunk completes the escape", () => {
    const part1 = unescapeTmuxOutputBytes("hello\\34");
    assert.equal(part1.carry, "\\34");
    const part2 = unescapeTmuxOutputBytes("2 world", part1.carry);
    assert.equal(part2.carry, "");
    // \342 = 0xE2, then literal " world" = 0x20 0x77 0x6f 0x72 0x6c 0x64
    assert.deepEqual([...part2.bytes], [0xe2, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64]);
  });

  it("decodes a single '█' (U+2588) split mid-escape across two chunks", () => {
    // U+2588 in UTF-8 = 0xE2 0x96 0x88 → tmux wire form \342\226\210
    const wire = "\\342\\226\\210"; // 12 chars
    // Split between chars 5 and 6 → "\\342\\" + "226\\210"
    const part1 = unescapeTmuxOutputBytes("\\342\\");
    assert.equal(part1.carry, "\\");
    assert.deepEqual([...part1.bytes], [0xe2]);
    const part2 = unescapeTmuxOutputBytes("226\\210", part1.carry);
    assert.equal(part2.carry, "");
    assert.deepEqual([...part2.bytes], [0x96, 0x88]);
    // Joined: 0xE2 0x96 0x88 = '█'
    assert.equal(
      Buffer.concat([part1.bytes, part2.bytes]).toString("utf-8"),
      "█",
    );
  });

  it("decodes a row of 26 '█' octal-escaped and split at every position", () => {
    // The exact pathology that produced the bug: a long row of high-byte
    // chars where the chunk boundary can fall anywhere inside the wire
    // representation. We exhaustively split at every position and verify
    // that the joined output round-trips perfectly.
    const blocks = "█".repeat(26);
    const wire = tmuxOctalEscape(Buffer.from(blocks, "utf-8"));
    assert.ok(wire.length > 100, "wire form should be long enough to split");

    for (let split = 0; split <= wire.length; split++) {
      const a = wire.slice(0, split);
      const b = wire.slice(split);
      const part1 = unescapeTmuxOutputBytes(a, "");
      const part2 = unescapeTmuxOutputBytes(b, part1.carry);
      assert.equal(part2.carry, "", `final carry should be empty at split=${split}`);
      const joined = Buffer.concat([part1.bytes, part2.bytes]).toString("utf-8");
      assert.equal(
        joined,
        blocks,
        `split=${split}: expected ${blocks.length} blocks, got ${joined.length} chars`,
      );
      assert.ok(
        !joined.includes("\uFFFD"),
        `split=${split}: should not contain U+FFFD`,
      );
    }
  });

  it("handles three-way splits in the middle of an escape", () => {
    // U+2588 = "\342\226\210" → split into 3 chunks of length 4, 4, 4.
    const wire = "\\342\\226\\210";
    let carry = "";
    const all = [];
    for (let i = 0; i < wire.length; i += 4) {
      const chunk = wire.slice(i, i + 4);
      const r = unescapeTmuxOutputBytes(chunk, carry);
      carry = r.carry;
      all.push(...r.bytes);
    }
    assert.equal(carry, "");
    assert.equal(Buffer.from(all).toString("utf-8"), "█");
  });
});

// --- Integration test against the real Session parser pipeline ---

describe("Session tmux output parser — partial octal escape across %output lines", () => {
  it("decodes a row of block chars when %output wraps mid-escape", () => {
    // Simulate the exact bug: Claude Code's banner row, octal-escaped by
    // tmux, where the per-message length limit happens to fall inside one
    // of the \NNN escapes. Without _octalCarry the row would render as
    // FFFD glyphs.
    const banner = "\x1b[33m" + "█".repeat(26) + "\x1b[0m\r\n";
    const wire = tmuxOctalEscape(Buffer.from(banner, "utf-8"));

    // Split position chosen so it lands inside an octal escape — between
    // chars 5 and 6 of "\342\226\210" which is the first '█'. The escape
    // sequence "\x1b[33m" octal-escapes to 17 chars (`\033[33m` = 7 chars
    // since `[` `3` `3` `m` are printable). Then each '█' is 12 chars.
    // Pick a split inside the third block char's escape run.
    const split = 7 /* "\033[33m" */ + 12 * 2 + 5; // mid-third-block

    const part1 = wire.slice(0, split);
    const part2 = wire.slice(split);

    const captured = [];
    const { session, proc } = createWiredSession("octal-split-test");
    // Raptor 3: onData fires with the decoded string payload for each
    // %output line. No RingBuffer cursor, no sliceFrom — the parser hands
    // the payload directly to the callback.
    session._onData = (_name, payload) => {
      if (typeof payload === "string" && payload.length) captured.push(payload);
    };

    proc.stdout.emit(`%output %0 ${part1}\n`);
    proc.stdout.emit(`%output %0 ${part2}\n`);

    const joined = captured.join("");
    assert.ok(
      !joined.includes("\uFFFD"),
      `output should not contain U+FFFD, got: ${JSON.stringify(joined)}`,
    );
    // The 26 block characters must all survive
    const blockCount = (joined.match(/█/g) || []).length;
    assert.equal(
      blockCount,
      26,
      `expected 26 block chars, got ${blockCount}: ${JSON.stringify(joined)}`,
    );
    // The terminating CR LF and color reset should be intact too
    assert.ok(joined.includes("\x1b[33m"), "color start should be intact");
    assert.ok(joined.includes("\x1b[0m"), "color reset should be intact");
    assert.ok(joined.endsWith("\r\n"), "CR LF terminator should be intact");
  });

  it("survives an exhaustive split-position sweep with no FFFD", () => {
    // Same as the unit test, but through the real Session parser. This
    // catches any state-management bug in _octalCarry between the parser
    // and the carry field on Session. Starts at split=0 (entire payload
    // in the second chunk) so we cover the "all carry from empty" edge.
    const banner = "█".repeat(10);
    const wire = tmuxOctalEscape(Buffer.from(banner, "utf-8"));

    for (let split = 0; split <= wire.length; split++) {
      const captured = [];
      const { session, proc } = createWiredSession(`split-${split}`);
      session._onData = (_name, payload) => {
        if (typeof payload === "string" && payload.length) captured.push(payload);
      };

      proc.stdout.emit(`%output %0 ${wire.slice(0, split)}\n`);
      proc.stdout.emit(`%output %0 ${wire.slice(split)}\n`);

      const joined = captured.join("");
      assert.ok(
        !joined.includes("\uFFFD"),
        `split=${split}: contains FFFD: ${JSON.stringify(joined)}`,
      );
      const count = (joined.match(/█/g) || []).length;
      assert.equal(
        count,
        10,
        `split=${split}: expected 10 blocks, got ${count}`,
      );
    }
  });

  it("attachControlMode clears stuck parser state from a prior attach", () => {
    // Regression: if attachControlMode didn't reset the parser, a partial
    // escape or half-buffered line left over from a previous detached
    // attach would corrupt the first %output of the next attach.
    //
    // We use a stubbed spawn so the test runs without a real tmux binary.
    // The stub returns a MockProc whose stdout we drive directly, which
    // means this test exercises the ACTUAL attachControlMode code path —
    // constructor reset, pre-wire parser reset, and the first %output
    // through the real parser.write() → parseLineBuf pipeline.
    let proc;
    const spawnStub = () => {
      proc = new MockProc();
      return proc;
    };
    const session = new Session(
      "reset-test",
      tmuxSessionName("reset-test"),
      { _spawn: spawnStub },
    );

    // Simulate residual state from a previous detach by feeding the parser
    // a half line that also ends with a partial octal escape. Without the
    // reset, the stuck carry + line buffer would desync the first byte of
    // the next attach's %output.
    session._parser.write(Buffer.from("%output %0 partial-no-newline\\34"));

    session.attachControlMode(80, 24);

    assert.ok(session.controlProc === proc, "controlProc should be the stub");

    // Drive a clean block-character run through the real parser and
    // verify no FFFD leaks from the old carry. If the reset were missing,
    // the stuck `\34` would combine with the first `\342...` and desync
    // every following escape, producing FFFD glyphs.
    const captured = [];
    session._onData = (_name, payload) => {
      if (typeof payload === "string" && payload.length) captured.push(payload);
    };
    const wire = tmuxOctalEscape(Buffer.from("█".repeat(5), "utf-8"));
    proc.stdout.emit(`%output %0 ${wire}\n`);

    const joined = captured.join("");
    assert.ok(
      !joined.includes("\uFFFD"),
      `post-reset %output contains FFFD: ${JSON.stringify(joined)}`,
    );
    assert.equal((joined.match(/█/g) || []).length, 5);
  });

  it("ignores a stale close event from a superseded process on reattach", () => {
    // Regression: when a session reattaches, the old controlProc's close
    // handler can fire *after* the new attach has already reset the
    // parser state and installed the new controlProc. Without a stale-proc
    // guard, the stale handler would call parser.drain() mid-stream
    // (prematurely flushing buffered bytes) and fire onExit on a
    // still-attached session (bogus "session exited" signal).
    //
    // The guard is `if (this.controlProc !== proc) return;` — we verify
    // it by firing close on proc1 *after* attaching with proc2, and
    // asserting onExit was NOT called and state is still ATTACHED.
    const procs = [];
    const spawnStub = () => {
      const p = new MockProc();
      procs.push(p);
      return p;
    };
    let onExitCalls = 0;
    const session = new Session(
      "stale-close-test",
      tmuxSessionName("stale-close-test"),
      { _spawn: spawnStub, onExit: () => { onExitCalls++; } },
    );

    session.attachControlMode(80, 24);
    const proc1 = procs[0];
    assert.ok(session.controlProc === proc1);

    // Reattach — replaces controlProc, resets parser state.
    session.attachControlMode(80, 24);
    const proc2 = procs[1];
    assert.ok(session.controlProc === proc2, "second attach should replace controlProc");
    assert.equal(session.state, Session.STATE_ATTACHED);

    // Fire close on the stale proc1. The guard must make this a no-op.
    proc1.fireClose(0);

    assert.equal(onExitCalls, 0, "stale close must not call onExit");
    assert.equal(session.state, Session.STATE_ATTACHED, "stale close must not detach");

    // Live close on proc2 should still work.
    proc2.fireClose(0);
    assert.equal(onExitCalls, 1, "live close should fire onExit once");
    assert.equal(session.state, Session.STATE_DETACHED);
  });
});
