//! Output-path primitives for the tmux → client wire.
//!
//! Two independently-testable pieces live here:
//!
//! - [`OctalDecoder`] — converts tmux control-mode `%output`'s
//!   octal-escape-encoded text (`\ooo` for non-printable bytes,
//!   `\\` for literal backslash) back into the raw byte stream
//!   the client's terminal emulator wants. **Stateful across
//!   calls**: tmux wraps long `%output` lines at a byte limit
//!   that can fall INSIDE a `\NNN` escape (Node scar `4dffb9f`),
//!   so a partial `\`, `\N`, or `\NN` at the end of one chunk
//!   must carry over to the next.
//!
//! - [`Coalescer`] — buffer for the output coalescing timing
//!   contract from Node scars `d311168` / `066dab2`: group
//!   `%output` chunks using a **2 ms idle timer** (resets on each
//!   arrival, waits for output to stop) combined with a **16 ms
//!   hard cap** (one 60 fps frame) so continuous streams don't
//!   starve. A pure timing primitive — no I/O, no awaits — so
//!   the handler's `tokio::select!` can drive it via
//!   `next_deadline()`.
//!
//! # Why both timers, not just one
//!
//! - **Idle alone** means `yes` or any continuous-output command
//!   never flushes — the idle deadline never elapses.
//! - **Cap alone** splits TUI frames that span multiple `%output`
//!   lines across multiple wire messages, breaking xterm.js'
//!   synchronised output and producing garbled text.
//!
//! Both together: complete frames go out as single wire messages,
//! continuous streams flush every 16 ms. Node shipped
//! `setImmediate`-style coalescing and an 8 ms fixed timer
//! before settling on 2 ms/16 ms — the fixed timer split frames
//! too; `setImmediate` only captured one I/O tick. Don't
//! reinvent either.
//!
//! # Why not decode at the subscriber
//!
//! The octal-decoder state is per-**pane**, not per-subscriber —
//! when slice 9h adds multi-device fan-out to the same pane,
//! every subscriber needs to see the same fully-decoded byte
//! stream. Decoding upstream of the fan-out (in the dispatcher)
//! keeps the carry buffer in one place. Slice 9f only has one
//! subscriber per pane so the placement is equivalent, but
//! picking the right home now means the multi-device slice
//! doesn't have to relocate the state.

use std::time::Duration;
use tokio::time::Instant;

/// Idle coalesce window. After the last `%output` arrived, wait
/// this long before flushing — if another chunk lands in that
/// window we reset and keep buffering. 2 ms was picked in Node
/// (`d311168`) because a TUI frame's `%output` bursts are
/// characteristically sub-millisecond between lines, and 2 ms is
/// long enough to coalesce a burst but short enough that users
/// don't perceive lag on keystroke echo.
pub const COALESCE_IDLE: Duration = Duration::from_millis(2);

/// Cap on how long a buffered burst can sit before being flushed
/// regardless of idleness. 16 ms ≈ one 60 fps frame — guarantees
/// that under a continuous-output command the client gets at
/// least 60 updates per second. Shorter values fragment frames;
/// longer values visibly stall the display.
pub const COALESCE_CAP: Duration = Duration::from_millis(16);

/// Output-path coalescer. Holds a byte buffer and the two
/// deadlines that gate its flush. Entirely synchronous — the
/// caller owns the timer via `next_deadline()` and `take()`.
///
/// Typical usage:
///
/// ```ignore
/// coalescer.push(bytes);
/// // select! on coalescer.next_deadline() alongside other events
/// let flushed = coalescer.take();
/// send(flushed);
/// ```
#[derive(Debug, Default)]
pub struct Coalescer {
    buf: Vec<u8>,
    /// When to flush because `%output` has been idle long enough
    /// (reset on each push).
    idle_deadline: Option<Instant>,
    /// When to flush regardless of idleness (set once per
    /// burst, on the first push into an empty buffer).
    cap_deadline: Option<Instant>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes to the pending burst. The cap deadline is set
    /// only on the transition from empty → non-empty buffer, so a
    /// long burst is capped from its FIRST byte; the idle deadline
    /// resets on every call so idle flushes correctly follow the
    /// LAST byte.
    pub fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let now = Instant::now();
        if self.buf.is_empty() {
            self.cap_deadline = Some(now + COALESCE_CAP);
        }
        self.buf.extend_from_slice(bytes);
        self.idle_deadline = Some(now + COALESCE_IDLE);
    }

    /// Earliest deadline the caller should await to flush this
    /// coalescer. `None` when the buffer is empty (no pending
    /// flush).
    pub fn next_deadline(&self) -> Option<Instant> {
        match (self.idle_deadline, self.cap_deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(d), None) | (None, Some(d)) => Some(d),
            (None, None) => None,
        }
    }

    /// Take the buffered bytes and clear both deadlines. Returns
    /// an empty vec if the buffer was empty (caller can use
    /// `is_empty()` to short-circuit).
    pub fn take(&mut self) -> Vec<u8> {
        self.idle_deadline = None;
        self.cap_deadline = None;
        std::mem::take(&mut self.buf)
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

/// Stateful tmux `%output` decoder.
///
/// tmux encodes `%output` payloads with two transformations:
///
/// - `\\` → literal `\`
/// - `\NNN` (three octal digits) → the byte whose value is that
///   octal number
///
/// Everything else is passed through byte-identically.
///
/// The decoder is stateful because tmux wraps long `%output`
/// lines at a byte limit that **can fall inside a `\NNN`
/// escape**. Without a carry buffer, a `\342\226\210` (the UTF-8
/// encoding of `█`) wrapping as `\342\226\2` + `10` produces a
/// literal `\` followed by bytes `342 226 2 10` from the first
/// chunk, and then `10` from the second — total garbage. The
/// carry buffer defers a trailing `\`, `\N`, or `\NN` until the
/// next chunk arrives, mirroring how a UTF-8 `StringDecoder`
/// buffers partial multi-byte sequences at a read boundary.
///
/// One decoder instance per pane — the carry spans `%output`
/// lines for the SAME pane, and tmux interleaves lines from
/// different panes freely. The dispatcher keyed per-pane-id
/// handles the 1:N mapping.
#[derive(Debug, Default)]
pub struct OctalDecoder {
    /// Accumulated bytes that LOOK like a partial escape: at most
    /// 3 bytes (`\`, `\N`, or `\NN`). Never more; once a 4th byte
    /// arrives we can always classify the escape one way or
    /// the other.
    carry: Vec<u8>,
}

impl OctalDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode one `%output` chunk, folding in any carry from the
    /// previous call. May push a new partial escape into the
    /// carry before returning; the next call will resume from it.
    ///
    /// Input is `&str` because `parser.rs` hands us the already-
    /// UTF-8-line-read text from tmux's stdout. We treat it as
    /// bytes anyway — the octal decoder is byte-level and tmux's
    /// pre-decode escaping keeps non-ASCII bytes inside `\NNN`
    /// sequences rather than leaking them as raw UTF-8.
    pub fn decode(&mut self, chunk: &str) -> Vec<u8> {
        // Fast path: nothing buffered, no backslash in chunk,
        // decoder is a no-op. Saves one allocation and one walk
        // on the common "printable ASCII only" case (shell
        // prompts, bare text).
        if self.carry.is_empty() && !chunk.contains('\\') {
            return chunk.as_bytes().to_vec();
        }

        // General path: concat carry + chunk, walk byte-wise.
        let mut combined = Vec::with_capacity(self.carry.len() + chunk.len());
        combined.extend_from_slice(&self.carry);
        combined.extend_from_slice(chunk.as_bytes());
        self.carry.clear();

        let mut out = Vec::with_capacity(combined.len());
        let mut i = 0;
        while i < combined.len() {
            if combined[i] != b'\\' {
                out.push(combined[i]);
                i += 1;
                continue;
            }
            // We're at a `\`. Decide based on what follows.
            let remaining = combined.len() - i;
            if remaining == 1 {
                // Trailing lone `\` — carry, come back next call.
                self.carry.push(b'\\');
                return out;
            }
            let next = combined[i + 1];
            if next == b'\\' {
                // `\\` → literal `\`
                out.push(b'\\');
                i += 2;
                continue;
            }
            if is_octal_digit(next) {
                if remaining < 4 {
                    // `\N` or `\NN` spanning the end — carry it.
                    self.carry.extend_from_slice(&combined[i..]);
                    return out;
                }
                let a = next;
                let b = combined[i + 2];
                let c = combined[i + 3];
                if is_octal_digit(b) && is_octal_digit(c) {
                    let value = (u16::from(a - b'0') << 6)
                        | (u16::from(b - b'0') << 3)
                        | u16::from(c - b'0');
                    // Three-digit octal can be up to 0o777 = 511.
                    // Values ≥ 256 cannot come from tmux
                    // (bytes are 0..=255); guard anyway so a
                    // malformed input can't write a u16-as-u8
                    // wrap.
                    if let Ok(byte) = u8::try_from(value) {
                        out.push(byte);
                        i += 4;
                        continue;
                    }
                }
                // `\N` where the next byte isn't octal (or the
                // 3-digit octal overflows): treat the `\` as
                // literal. tmux shouldn't emit this, but a
                // defensive path beats silent corruption.
                out.push(b'\\');
                i += 1;
                continue;
            }
            // `\` followed by a non-octal non-`\`: treat the
            // `\` as literal. Shouldn't arise from tmux.
            out.push(b'\\');
            i += 1;
        }

        out
    }

    /// Return any bytes still in the carry buffer and clear it.
    /// Called at shutdown / detach so trailing malformed escapes
    /// don't vanish silently. In well-formed tmux output the
    /// carry is empty between complete escape sequences.
    pub fn take_carry(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.carry)
    }

    #[cfg(test)]
    pub fn carry_len(&self) -> usize {
        self.carry.len()
    }
}

fn is_octal_digit(b: u8) -> bool {
    (b'0'..=b'7').contains(&b)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- OctalDecoder tests ----------

    #[test]
    fn plain_ascii_passes_through() {
        let mut d = OctalDecoder::new();
        assert_eq!(d.decode("hello world"), b"hello world");
        assert_eq!(d.carry_len(), 0);
    }

    #[test]
    fn double_backslash_decodes_to_single() {
        let mut d = OctalDecoder::new();
        assert_eq!(d.decode(r"C:\\Users"), b"C:\\Users");
    }

    #[test]
    fn three_digit_octal_decodes() {
        let mut d = OctalDecoder::new();
        // \033 = 0o33 = 27 = ESC
        assert_eq!(d.decode(r"\033[2J"), &[0x1B, b'[', b'2', b'J']);
    }

    #[test]
    fn utf8_box_drawing_decodes() {
        // `█` = U+2588 = UTF-8 0xE2 0x96 0x88 = `\342\226\210`.
        let mut d = OctalDecoder::new();
        assert_eq!(d.decode(r"\342\226\210"), &[0xE2, 0x96, 0x88]);
    }

    #[test]
    fn carry_resumes_partial_trailing_backslash() {
        // Node scar `4dffb9f`: tmux can split `\NNN` at byte
        // boundaries. Single `\` at end must carry.
        let mut d = OctalDecoder::new();
        let out1 = d.decode("prefix\\");
        assert_eq!(out1, b"prefix");
        assert_eq!(d.carry_len(), 1, "trailing `\\` must be held");
        let out2 = d.decode("033suffix");
        assert_eq!(out2, &[0x1B, b's', b'u', b'f', b'f', b'i', b'x']);
        assert_eq!(d.carry_len(), 0);
    }

    #[test]
    fn carry_resumes_partial_backslash_n() {
        let mut d = OctalDecoder::new();
        let out1 = d.decode("before\\0");
        assert_eq!(out1, b"before");
        assert_eq!(d.carry_len(), 2);
        let out2 = d.decode("33after");
        assert_eq!(out2, &[0x1B, b'a', b'f', b't', b'e', b'r']);
    }

    #[test]
    fn carry_resumes_partial_backslash_nn() {
        let mut d = OctalDecoder::new();
        let out1 = d.decode("x\\34");
        assert_eq!(out1, b"x");
        assert_eq!(d.carry_len(), 3);
        let out2 = d.decode("2y");
        // \342 = 0xE2
        assert_eq!(out2, &[0xE2, b'y']);
    }

    #[test]
    fn carry_across_utf8_box_boundary() {
        // The concrete Node-scar scenario: box-drawing char split
        // mid-escape. `█` = `\342\226\210`. Split after the
        // partial second escape.
        let mut d = OctalDecoder::new();
        let out1 = d.decode(r"\342\226\2");
        assert_eq!(out1, &[0xE2, 0x96]);
        let out2 = d.decode("10");
        assert_eq!(out2, &[0x88]);
    }

    #[test]
    fn backslash_followed_by_non_octal_is_literal() {
        let mut d = OctalDecoder::new();
        // Shouldn't arise from tmux, but must not corrupt output.
        assert_eq!(d.decode(r"\x"), b"\\x");
    }

    #[test]
    fn take_carry_drains_leftover() {
        let mut d = OctalDecoder::new();
        let _ = d.decode("end\\");
        assert_eq!(d.take_carry(), b"\\");
        assert_eq!(d.carry_len(), 0);
    }

    #[test]
    fn fast_path_no_backslash_no_allocation_correctness() {
        // The fast-path branch exists for perf, not semantics.
        // Double-check it matches the slow path byte-for-byte.
        let mut d = OctalDecoder::new();
        let input = "a very long prompt with $PATH and numbers 1234567890";
        assert_eq!(d.decode(input), input.as_bytes());
    }

    // ---------- Coalescer tests ----------

    #[tokio::test(start_paused = true)]
    async fn empty_coalescer_has_no_deadline() {
        let c = Coalescer::new();
        assert_eq!(c.next_deadline(), None);
        assert!(c.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn push_sets_idle_and_cap_deadlines() {
        let mut c = Coalescer::new();
        let start = Instant::now();
        c.push(b"hello");
        let deadline = c.next_deadline().expect("deadline set after push");
        // next_deadline is min(idle, cap) = idle (2ms < 16ms)
        assert_eq!(deadline, start + COALESCE_IDLE);
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_push_resets_idle_but_not_cap() {
        let mut c = Coalescer::new();
        let start = Instant::now();
        c.push(b"first");
        // Advance 1 ms — still inside both deadlines.
        tokio::time::advance(Duration::from_millis(1)).await;
        c.push(b"second");
        let deadline = c.next_deadline().unwrap();
        // Idle deadline reset to now+2ms = start+3ms. Cap
        // deadline unchanged = start+16ms. min is idle.
        assert_eq!(deadline, start + Duration::from_millis(3));
    }

    #[tokio::test(start_paused = true)]
    async fn cap_wins_for_continuous_push() {
        // Continuous push every 1 ms keeps resetting idle, so the
        // cap deadline takes over — this is the Node scar
        // "setImmediate never flushes under yes"; with cap we're
        // guaranteed a flush at 16 ms.
        let mut c = Coalescer::new();
        let start = Instant::now();
        for _ in 0..20 {
            c.push(b"x");
            tokio::time::advance(Duration::from_millis(1)).await;
        }
        let deadline = c.next_deadline().unwrap();
        // Cap deadline was set on the FIRST push at t=0 and is at
        // t+16ms. After 20 ms of advance we're past it.
        assert_eq!(deadline, start + COALESCE_CAP);
        // Now we're at t=20ms, so the deadline is in the past.
        assert!(
            Instant::now() >= deadline,
            "cap deadline must have elapsed"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn take_clears_buf_and_deadlines() {
        let mut c = Coalescer::new();
        c.push(b"abc");
        let taken = c.take();
        assert_eq!(taken, b"abc");
        assert!(c.is_empty());
        assert_eq!(c.next_deadline(), None);
        // A push after take restarts the cap.
        let resume = Instant::now();
        c.push(b"d");
        assert_eq!(c.next_deadline().unwrap(), resume + COALESCE_IDLE);
    }

    #[tokio::test(start_paused = true)]
    async fn push_empty_is_noop() {
        let mut c = Coalescer::new();
        c.push(b"");
        assert!(c.is_empty());
        assert_eq!(c.next_deadline(), None);
    }
}
