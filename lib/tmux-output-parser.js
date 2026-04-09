/**
 * Tmux control-mode output parser (byte-level).
 *
 * Given a stream of raw bytes from `tmux -C attach-session` stdout, this
 * parser emits decoded UTF-8 payloads from `%output %pane_id <escaped>`
 * lines. Everything else (`%begin`, `%end`, `%error`, `%session-changed`,
 * …) is silently dropped — we only care about terminal I/O here.
 *
 * Why byte-level
 * - tmux splits long %output payloads at fixed byte boundaries without
 *   regard to UTF-8 character boundaries. A multi-byte char like `─`
 *   (e2 94 80) can end up with `e2` on one line and `94 80` on the next.
 * - Running a stream-level StringDecoder over raw stdout therefore emits
 *   U+FFFD for the orphaned lead/continuation bytes before we ever get
 *   to the %output payload layer, corrupting box-drawing chars, TUI
 *   escape sequences, and anything else non-ASCII.
 * - Fix: scan for `\n` (0x0a) over raw Buffers, match the ASCII
 *   `%output %<pane_id> ` prefix as bytes, and feed the octal-unescaped
 *   payload bytes through a single persistent StringDecoder. That
 *   decoder is the one and only place UTF-8 → string conversion
 *   happens, and it correctly carries partial multi-byte chars across
 *   calls.
 *
 * State it owns (all rebuildable on reset())
 * - `lineBuf`: Buffer of partial line bytes assembled across stdout
 *   chunks (tmux writes lines one at a time but chunk boundaries can
 *   split a line).
 * - `payloadDecoder`: StringDecoder for %output payload bytes, persistent
 *   across lines so multi-byte UTF-8 chars that span %output lines don't
 *   become U+FFFD.
 * - `octalCarry`: 1-3 chars of a partial `\NNN` tmux octal escape
 *   deferred from the previous %output line. See
 *   {@link unescapeTmuxOutputBytes} in lib/tmux.js for the rationale.
 *
 * Contract
 * - `write(chunk)` → synchronously fires `onData(payload)` zero or more
 *   times, one per decoded `%output` line.
 * - `drain()` → flushes the payload decoder and line buffer, fires any
 *   pending `onData`, and resets internal state so a second drain is a
 *   no-op.
 * - `reset()` → discards all state without emitting.
 */

import { StringDecoder } from "node:string_decoder";
import { driftLog, driftLogLevel } from "./drift-log.js";

// ASCII "%output " — matched as bytes against incoming lines.
const OUTPUT_PREFIX = Buffer.from("%output ");
const NL = 0x0a;
const SPACE = 0x20;
const BACKSLASH = 0x5c;
const ZERO = 0x30;

/**
 * Byte-level unescape of a tmux %output payload.
 *
 * tmux escapes bytes `< 0x20` and `\` as three-digit octal `\NNN`. Every
 * other byte (including all high bytes of multi-byte UTF-8 chars) is
 * emitted literally. We MUST stay in byte space here — converting the
 * payload to a JS string first would re-encode literal `0xe2` (say) as
 * U+00E2 and then back to `c3 a2`, double-encoding every non-ASCII char.
 *
 * The `carry` holds 1-3 bytes of a partial `\NNN` escape deferred from
 * the previous %output line. See the original note in lib/tmux.js for
 * why this matters: a long run of high bytes can be split mid-escape
 * across two %output lines.
 */
function unescapeOutputBytes(buf, carryBytes) {
  // Prepend carry if any. carryBytes is a Buffer of length 0-3.
  const input = carryBytes.length === 0 ? buf : Buffer.concat([carryBytes, buf]);
  const out = Buffer.allocUnsafe(input.length);
  let w = 0;
  let i = 0;
  while (i < input.length) {
    const b = input[i];
    if (b === BACKSLASH) {
      if (i + 3 >= input.length) {
        return { bytes: out.subarray(0, w), carry: input.subarray(i) };
      }
      const d0 = input[i + 1] - ZERO;
      const d1 = input[i + 2] - ZERO;
      const d2 = input[i + 3] - ZERO;
      if (d0 >= 0 && d0 <= 3 && d1 >= 0 && d1 <= 7 && d2 >= 0 && d2 <= 7) {
        out[w++] = d0 * 64 + d1 * 8 + d2;
        i += 4;
        continue;
      }
      // Malformed — pass backslash through literally.
    }
    out[w++] = b;
    i++;
  }
  return { bytes: out.subarray(0, w), carry: Buffer.alloc(0) };
}

/**
 * Create a tmux control-mode output parser.
 *
 * @param {object} opts
 * @param {(payload: string) => void} opts.onData - Called once per decoded
 *   %output line with the UTF-8 string.
 * @returns {{ write: (chunk: Buffer|string) => void, drain: () => void, reset: () => void }}
 */
export function createTmuxOutputParser({ onData }) {
  let lineBuf = Buffer.alloc(0);
  let payloadDecoder = new StringDecoder("utf-8");
  let octalCarry = Buffer.alloc(0);
  const RECENT_CHUNKS_MAX = 4;
  let recentChunks = [];

  function parseLineBuf() {
    let startIdx = 0;
    let nlPos;
    while ((nlPos = lineBuf.indexOf(NL, startIdx)) !== -1) {
      const line = lineBuf.subarray(startIdx, nlPos);
      startIdx = nlPos + 1;

      // Fast reject: anything not starting with "%output " is framing
      // noise (%begin, %end, %session-changed, …). We don't need to
      // decode it — just skip.
      if (line.length < OUTPUT_PREFIX.length) continue;
      let isOutput = true;
      for (let i = 0; i < OUTPUT_PREFIX.length; i++) {
        if (line[i] !== OUTPUT_PREFIX[i]) { isOutput = false; break; }
      }
      if (!isOutput) continue;

      // After "%output " comes "%<pane_id> <escaped_payload>".
      // Find the space that terminates the pane id.
      const rest = line.subarray(OUTPUT_PREFIX.length);
      const spacePos = rest.indexOf(SPACE);
      if (spacePos === -1) continue;

      // Payload stays as bytes all the way through. tmux emits high
      // bytes (UTF-8 continuation bytes, etc.) literally — converting
      // to string first would double-encode them.
      const escapedBuf = rest.subarray(spacePos + 1);

      const { bytes: rawBytes, carry } = unescapeOutputBytes(escapedBuf, octalCarry);
      octalCarry = carry;
      const data = payloadDecoder.write(rawBytes);
      if (!data) continue;

      // Deep byte-level probe: only at level 2 because it builds hex
      // dumps of the rolling raw-chunk buffer, which is expensive.
      if (driftLogLevel() >= 2 && data.indexOf("\uFFFD") !== -1) {
        const idx = data.indexOf("\uFFFD");
        let recentChunksHasFffdBytes = false;
        const recentHex = recentChunks.map(b => {
          if (b.includes(Buffer.from([0xef, 0xbf, 0xbd]))) {
            recentChunksHasFffdBytes = true;
          }
          return b.slice(0, 200).toString("hex");
        });
        driftLog({
          event: "parser-fffd",
          recentChunksHasFffdBytes,
          decodedSample: data.slice(Math.max(0, idx - 20), idx + 20),
          rawBytesLen: rawBytes.length,
          rawBytesHexHead: rawBytes.slice(0, 200).toString("hex"),
          escapedLen: escapedBuf.length,
          escapedHexHead: escapedBuf.slice(0, 200).toString("hex"),
          recentChunkCount: recentChunks.length,
          recentChunkHexHead: recentHex,
          recentChunkLens: recentChunks.map(b => b.length),
        }, 2);
      }
      onData(data);
    }
    if (startIdx > 0) {
      lineBuf = startIdx === lineBuf.length ? Buffer.alloc(0) : lineBuf.subarray(startIdx);
    }
  }

  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (driftLogLevel() >= 2) {
        recentChunks.push(buf);
        if (recentChunks.length > RECENT_CHUNKS_MAX) recentChunks.shift();
      }
      lineBuf = lineBuf.length === 0 ? buf : Buffer.concat([lineBuf, buf]);
      parseLineBuf();
    },

    drain() {
      // If there's a trailing line without a newline, synthesize one so
      // parseLineBuf picks it up. Safe: tmux always terminates %output
      // lines with \n, so a tail without \n is either framing noise or
      // a truncated line we can't trust anyway — but if it happens to
      // be a valid %output line we still want to flush its payload.
      if (lineBuf.length > 0) {
        lineBuf = Buffer.concat([lineBuf, Buffer.from([NL])]);
        parseLineBuf();
      }
      const payloadTail = payloadDecoder.end();
      if (payloadTail) onData(payloadTail);

      lineBuf = Buffer.alloc(0);
      payloadDecoder = new StringDecoder("utf-8");
      octalCarry = Buffer.alloc(0);
    },

    reset() {
      lineBuf = Buffer.alloc(0);
      payloadDecoder = new StringDecoder("utf-8");
      octalCarry = Buffer.alloc(0);
    },
  };
}
