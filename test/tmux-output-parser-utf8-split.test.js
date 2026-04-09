/**
 * Regression tests for the tmux output parser: multi-byte UTF-8 chars
 * split across %output boundaries.
 *
 * Bug symptom (v0.52.4 and earlier):
 *   TUI apps rendered with bursts of ◆ / U+FFFD replacing non-ASCII text,
 *   stacked "Doodling..." spinners, stray horizontal ruler lines in
 *   scrollback, and leftover Claude-Code TUI fragments after exit. Each
 *   corruption compounded because the corrupted bytes included escape
 *   sequences (scroll region, cursor position, alt-screen), and the
 *   client's xterm then interpreted broken escapes and put subsequent
 *   writes on the wrong cells.
 *
 * Root cause:
 *   tmux control mode wraps %output payloads at fixed byte limits with
 *   no regard for UTF-8 boundaries. A single char like `─` (0xe2 0x94
 *   0x80) can end up with `0xe2` on one %output line and `0x94 0x80` on
 *   the next. Tmux can ALSO emit high bytes literally (not octal-
 *   escaped) when running with -u or when certain modes are active.
 *
 *   The pre-fix parser ran a stream-level Node `StringDecoder` over raw
 *   stdout. That decoder dutifully emitted U+FFFD for the orphaned
 *   0xe2 lead byte and for the orphaned continuation bytes on the next
 *   line — corrupting every multi-byte char that straddled a boundary.
 *
 *   An earlier partial fix added a "payloadDecoder" alongside the
 *   stream-level "frameDecoder", but payloadDecoder received already-
 *   corrupted strings (the damage happened one layer up). A later
 *   attempt converted the payload Buffer to a latin1 string and then
 *   fed it through `unescapeTmuxOutputBytes` — which codePointAt-reads
 *   literal 0xe2 as U+00E2 and re-encodes it as `c3 a2`, double-
 *   encoding every non-ASCII byte.
 *
 * Correct fix (what this test pins):
 *   Stay in byte space from stdout all the way through octal unescape,
 *   and only convert to a JS string at the very end via a SINGLE
 *   persistent StringDecoder. That decoder's internal buffer then
 *   correctly carries partial multi-byte chars across %output lines.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { createTmuxOutputParser } from "../lib/tmux-output-parser.js";

function collect() {
  const out = [];
  const parser = createTmuxOutputParser({ onData: (s) => out.push(s) });
  return { parser, out, joined: () => out.join("") };
}

describe("tmux output parser — literal high bytes (no octal escaping)", () => {
  it("decodes a single `─` (0xe2 0x94 0x80) emitted literally", () => {
    const { parser, joined } = collect();
    // Tmux with -u can emit high bytes literally. We build a raw stdout
    // chunk that contains the three bytes verbatim inside a %output
    // line — no backslash escapes — to pin that the parser passes
    // literal high bytes through untouched.
    const line = Buffer.concat([
      Buffer.from("%output %0 "),
      Buffer.from([0xe2, 0x94, 0x80]),
      Buffer.from("\n"),
    ]);
    parser.write(line);
    assert.equal(joined(), "─");
  });

  it("does NOT double-encode literal high bytes via latin1 round-trip", () => {
    // Regression for the intermediate buggy fix that did
    // `rest.toString('latin1')` and then passed the string to
    // unescapeTmuxOutputBytes (which UTF-8-encodes each codepoint).
    // Under that bug, 0xe2 → U+00E2 → c3 a2, so the output would be
    // "â" (U+00E2) rendered as two UTF-8 bytes, NOT the original `─`.
    const { parser, joined } = collect();
    const blocks = Buffer.alloc(10 * 3);
    for (let i = 0; i < 10; i++) {
      blocks[i * 3 + 0] = 0xe2;
      blocks[i * 3 + 1] = 0x94;
      blocks[i * 3 + 2] = 0x80;
    }
    parser.write(Buffer.concat([
      Buffer.from("%output %0 "),
      blocks,
      Buffer.from("\n"),
    ]));
    assert.equal(joined(), "─".repeat(10));
    assert.ok(!joined().includes("\u00e2"), "must not contain U+00E2 (double-encoded)");
    assert.ok(!joined().includes("\uFFFD"), "must not contain U+FFFD");
  });

  it("joins a `─` split across two %output lines (the original bug)", () => {
    // The exact pathology: tmux wraps the %output payload mid-char,
    // so the lead byte e2 ends one line and the continuation bytes
    // 94 80 start the next. The persistent payload decoder must
    // carry the partial char between lines.
    const { parser, joined } = collect();
    parser.write(Buffer.concat([
      Buffer.from("%output %0 "),
      Buffer.from([0xe2]),
      Buffer.from("\n%output %0 "),
      Buffer.from([0x94, 0x80]),
      Buffer.from("\n"),
    ]));
    assert.equal(joined(), "─");
    assert.ok(!joined().includes("\uFFFD"));
  });

  it("joins a `─` split across two raw stdout chunks mid-%output-line", () => {
    // Second flavour: the UTF-8 char is all on one %output line but
    // the raw stdout chunk boundary splits it. The parser must buffer
    // the partial line at the byte level (not via a stream-level
    // StringDecoder that would immediately emit FFFD).
    const { parser, joined } = collect();
    parser.write(Buffer.concat([
      Buffer.from("%output %0 "),
      Buffer.from([0xe2]),
    ]));
    parser.write(Buffer.concat([
      Buffer.from([0x94, 0x80]),
      Buffer.from("\n"),
    ]));
    assert.equal(joined(), "─");
  });

  it("exhaustively survives single-char splits at every byte position", () => {
    // A row of 20 box-drawing chars, split at every possible raw-chunk
    // boundary. Every split must produce the exact original string
    // with zero FFFDs.
    const row = "─".repeat(20);
    const payload = Buffer.from(row, "utf-8");
    const full = Buffer.concat([
      Buffer.from("%output %0 "),
      payload,
      Buffer.from("\n"),
    ]);
    for (let split = 1; split < full.length; split++) {
      const { parser, joined } = collect();
      parser.write(full.subarray(0, split));
      parser.write(full.subarray(split));
      assert.equal(
        joined(),
        row,
        `split=${split}: expected ${row.length} chars, got ${JSON.stringify(joined())}`,
      );
      assert.ok(
        !joined().includes("\uFFFD"),
        `split=${split}: contains U+FFFD`,
      );
    }
  });

  it("preserves octal-escaped low bytes alongside literal high bytes", () => {
    // Realistic payload mixing both: a CR (octal \015), a literal `─`,
    // and plain ASCII. Tmux escapes control chars and backslash but
    // emits high bytes literally.
    const { parser, joined } = collect();
    const payload = Buffer.concat([
      Buffer.from("hello\\015"), // ASCII + octal CR
      Buffer.from([0xe2, 0x94, 0x80]), // literal `─`
      Buffer.from("world"),
    ]);
    parser.write(Buffer.concat([
      Buffer.from("%output %0 "),
      payload,
      Buffer.from("\n"),
    ]));
    assert.equal(joined(), "hello\r─world");
  });

  it("ignores framing lines (%begin/%end/%session-changed)", () => {
    const { parser, joined } = collect();
    parser.write(Buffer.from(
      "%begin 123 456 0\n" +
      "%output %0 alpha\n" +
      "%end 123 456 0\n" +
      "%session-changed $0 whatever\n" +
      "%output %0 beta\n",
    ));
    assert.equal(joined(), "alphabeta");
  });

  it("reset() clears partial-line and partial-char state", () => {
    const { parser, joined } = collect();
    // Feed a partial %output line (no newline) and a leading UTF-8 byte.
    parser.write(Buffer.concat([
      Buffer.from("%output %0 "),
      Buffer.from([0xe2]),
    ]));
    // Reset — the stray 0xe2 must not corrupt the next attach.
    parser.reset();
    parser.write(Buffer.from("%output %0 clean\n"));
    assert.equal(joined(), "clean");
    assert.ok(!joined().includes("\uFFFD"));
  });
});
