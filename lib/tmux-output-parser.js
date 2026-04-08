/**
 * Tmux control-mode output parser.
 *
 * Given a stream of raw bytes from `tmux -C attach-session` stdout, this
 * parser emits decoded UTF-8 payloads from `%output %pane_id <escaped>`
 * lines. Everything else (`%begin`, `%end`, `%error`, `%session-changed`,
 * …) is silently dropped — we only care about terminal I/O here.
 *
 * Why it lives in its own module
 * - The parsing is a cohesive chunk of state that has nothing to do with
 *   the Session domain object (tmux lifecycle, resize gate, screen mirror).
 *   Extracting it lets Session stay focused on "what is a terminal session"
 *   while the parser handles "how do we decode the tmux protocol".
 * - It becomes trivially unit-testable by feeding chunked bytes into
 *   `write()` and asserting the `onData` callback fires — no tmux spawn,
 *   no child process, no fixtures.
 *
 * State it owns (all rebuildable on reset())
 * - `lineBuf`: partial line assembled across stdout chunks (tmux writes
 *   lines one-at-a-time but chunk boundaries can split a line)
 * - `frameDecoder`: StringDecoder for the control-mode framing layer —
 *   handles any multi-byte UTF-8 that might appear in a `%session-changed`
 *   event or similar
 * - `payloadDecoder`: separate StringDecoder for `%output` payload bytes,
 *   so multi-byte UTF-8 chars that span `%output` lines don't become
 *   U+FFFD. Must be separate from `frameDecoder` because %output is
 *   "decoded → bytes → UTF-8" while framing is "bytes → UTF-8 → lines".
 * - `octalCarry`: 1-3 chars of a partial `\NNN` tmux octal escape
 *   deferred from the previous %output line. See
 *   {@link unescapeTmuxOutputBytes} in lib/tmux.js for the rationale.
 *
 * Contract
 * - `write(chunk)` → synchronously fires `onData(payload)` zero or more
 *   times, one per decoded `%output` line.
 * - `drain()` → flushes both decoders and the line buffer, fires any
 *   pending `onData`, and resets internal state so a second drain is a
 *   no-op. Used by Session on detach/kill to avoid dropping trailing
 *   UTF-8 bytes buffered inside the decoders.
 * - `reset()` → discards all state without emitting. Used at the start
 *   of a new attach so stale bytes from a prior attach don't corrupt
 *   the first bytes of the next stream.
 */

import { StringDecoder } from "node:string_decoder";
import { unescapeTmuxOutputBytes } from "./tmux.js";

/**
 * Create a tmux control-mode output parser.
 *
 * @param {object} opts
 * @param {(payload: string) => void} opts.onData - Called once per decoded
 *   %output line with the UTF-8 string. The caller is responsible for
 *   pushing the payload into a RingBuffer / screen mirror / etc.
 * @returns {{ write: (chunk: Buffer|string) => void, drain: () => void, reset: () => void }}
 */
export function createTmuxOutputParser({ onData }) {
  let lineBuf = "";
  let frameDecoder = new StringDecoder("utf-8");
  let payloadDecoder = new StringDecoder("utf-8");
  let octalCarry = "";

  /**
   * Parse complete lines from `lineBuf` and emit decoded %output payloads.
   * Trailing partial line is left in `lineBuf` for the next write/drain.
   */
  function parseLineBuf() {
    let startIdx = 0;
    let nlPos;
    while ((nlPos = lineBuf.indexOf("\n", startIdx)) !== -1) {
      const line = lineBuf.slice(startIdx, nlPos);
      startIdx = nlPos + 1;

      if (line.startsWith("%output ")) {
        // Format: %output %pane_id octal_escaped_data
        const rest = line.slice(8); // after "%output "
        const spacePos = rest.indexOf(" ");
        if (spacePos !== -1) {
          const escaped = rest.slice(spacePos + 1);
          // Octal → bytes → UTF-8 via octalCarry + payloadDecoder. See
          // unescapeTmuxOutputBytes for why the carry is load-bearing.
          const { bytes: rawBytes, carry } = unescapeTmuxOutputBytes(escaped, octalCarry);
          octalCarry = carry;
          const data = payloadDecoder.write(rawBytes);
          if (!data) continue; // incomplete multi-byte char, buffered for next line
          onData(data);
        }
      }
      // Ignore %begin, %end, %error, %session-changed, etc.
    }
    if (startIdx > 0) lineBuf = lineBuf.slice(startIdx);
  }

  return {
    /**
     * Feed a chunk of raw stdout bytes into the parser.
     * Synchronously fires `onData` zero or more times.
     */
    write(chunk) {
      lineBuf += frameDecoder.write(chunk);
      parseLineBuf();
    },

    /**
     * Flush any buffered state and fire `onData` for trailing content.
     *
     * Called by Session on detach/kill BEFORE clearing the onData callback,
     * so partial UTF-8 buffered inside `payloadDecoder` or mid-line bytes
     * in `frameDecoder` reach subscribers instead of being silently dropped.
     *
     * Idempotent: after draining, state is reset so a second call is a no-op.
     */
    drain() {
      // Drain framing decoder into the line buffer and parse complete lines.
      const tail = frameDecoder.end();
      if (tail) {
        lineBuf += tail;
        parseLineBuf();
      }
      // Drain payload decoder. Any bytes mid-multi-byte-char become U+FFFD,
      // which is the correct contract for StringDecoder.end(). Emit the tail
      // as a final synthetic payload so subscribers see the trailing
      // character instead of losing it.
      const payloadTail = payloadDecoder.end();
      if (payloadTail) onData(payloadTail);

      // Reset to fresh state so a second drain is a no-op.
      lineBuf = "";
      frameDecoder = new StringDecoder("utf-8");
      payloadDecoder = new StringDecoder("utf-8");
      octalCarry = "";
    },

    /**
     * Discard all buffered state without emitting.
     *
     * Called at the start of a new attach so stale bytes from a prior
     * attach can't corrupt the first bytes of the next stream.
     */
    reset() {
      lineBuf = "";
      frameDecoder = new StringDecoder("utf-8");
      payloadDecoder = new StringDecoder("utf-8");
      octalCarry = "";
    },
  };
}
