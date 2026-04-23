//! Per-pane byte-ring for reconnect replay.
//!
//! A fixed-capacity circular byte buffer tagged with the total
//! number of bytes ever written. Clients that drop the connection
//! and reconnect with `resume_from_seq = N` can be handed back
//! `ring.read_after(N)` — whatever of their recent-history we
//! still have — letting the terminal rebuild state without a
//! full screen redraw.
//!
//! # What this is NOT
//!
//! - Not a full screen snapshot. TUI apps that use absolute
//!   cursor positioning (`\e[row;colH`) rely on tmux's live
//!   state, which this ring doesn't capture. A reconnect after
//!   `vim` running for a while will see a mid-frame byte
//!   sequence, not a redrawn editor. The Node port ran its own
//!   headless xterm for this; katulong's plan is to defer that
//!   kind of rich-state capture until there's a concrete
//!   consumer requiring it (slice 9h or later).
//! - Not a log. Old bytes are overwritten. The operator looking
//!   for "what did the shell print at 9 AM" wants tmux's own
//!   buffer capture (`capture-pane`), not this ring.
//!
//! # Capacity tuning
//!
//! 64 KiB per pane. Rationale:
//! - Plenty for a full 200×60 screen worth of text output
//!   (~12 KiB of plain chars; up to ~30 KiB with a bunch of
//!   SGR escapes).
//! - Well below any memory concern for a single-user install:
//!   even 10 concurrent panes = 640 KiB.
//! - Matches the 64 KiB WS frame cap so a replay always fits
//!   in one `ServerMessage::Output`.
//!
//! Sizing is per-pane, NOT per-connection — the router's
//! attach-displaces-prior semantics mean a reconnecting client
//! from the same device carries the same pane's history forward
//! without the ring size multiplying.
//!
//! # Byte-level vs message-level replay
//!
//! The ring stores RAW decoded bytes (post-octal-decode, pre-
//! coalesce). Sequence numbers are byte-level offsets — the
//! total bytes ever written, as a `u64`. This is unambiguous
//! and doesn't care about the coalescer's message boundaries.
//! The coalescer in the handler still batches for wire
//! efficiency; on reconnect we hand over one big replay blob
//! without caring how the pre-disconnect stream was chunked.

use std::collections::VecDeque;

/// Default capacity per pane. Consts so tests can override via
/// `with_capacity`.
pub const DEFAULT_CAPACITY: usize = 64 * 1024;

/// A replay request result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplaySlice {
    /// Everything the client requested is still in the ring.
    /// `data` is the bytes from `after_seq` (exclusive) through
    /// `end_seq` (inclusive by byte count — i.e., `end_seq` is
    /// the `total_written()` at read time).
    InRange { data: Vec<u8>, end_seq: u64 },
    /// The client's `after_seq` is older than what the ring
    /// still holds. `data` is what we CAN replay (the full
    /// current ring contents), and `available_from_seq` is the
    /// oldest byte offset in that data. The client must clear
    /// its terminal / hard-redraw before applying the data,
    /// because the gap means cursor positions and in-flight
    /// escape sequences can't be inferred.
    Gap {
        available_from_seq: u64,
        data: Vec<u8>,
        end_seq: u64,
    },
    /// The client sent `after_seq > total_written` — they claim
    /// to have more bytes than we ever produced. Treat as a
    /// protocol violation; the handler closes the connection.
    Future,
    /// The client is already up-to-date (`after_seq ==
    /// total_written`). Nothing to replay; caller proceeds
    /// straight to live output.
    UpToDate { end_seq: u64 },
}

/// Fixed-capacity byte ring with a running total-bytes counter.
///
/// `VecDeque<u8>` under the hood. Per-byte push/pop is amortised
/// O(1); the batch `append` drains/extends in bulk rather than
/// byte-by-byte. At 64 KiB capacity a full flush is sub-
/// microsecond.
#[derive(Debug)]
pub struct RingBuffer {
    buf: VecDeque<u8>,
    capacity: usize,
    total_written: u64,
}

impl RingBuffer {
    /// New ring with the default 64 KiB capacity.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity.min(DEFAULT_CAPACITY)),
            capacity,
            total_written: 0,
        }
    }

    /// Append bytes. If the incoming slice alone exceeds the
    /// ring's capacity, only the tail fits — the head of the
    /// input plus any existing contents are discarded. This is
    /// correct for a "last N bytes" ring: a one-shot 200 KiB
    /// paste lands with the last 64 KiB kept.
    pub fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.total_written = self.total_written.saturating_add(bytes.len() as u64);

        if bytes.len() >= self.capacity {
            // Input alone overflows capacity. Keep only its tail.
            self.buf.clear();
            let start = bytes.len() - self.capacity;
            self.buf.extend(&bytes[start..]);
            return;
        }

        // Mixed: some existing bytes stay, some get evicted.
        let new_total = self.buf.len() + bytes.len();
        if new_total > self.capacity {
            let drop_n = new_total - self.capacity;
            self.buf.drain(..drop_n);
        }
        self.buf.extend(bytes);
    }

    /// Total bytes ever written since construction. Monotonic —
    /// never resets. This is the wire `seq` semantics (each
    /// `ServerMessage::Output.seq` carries the total_written at
    /// the end of that chunk).
    pub fn total_written(&self) -> u64 {
        self.total_written
    }

    /// Oldest byte offset still in the ring. Equals
    /// `total_written - buf.len()`. When the ring is not full
    /// this is 0.
    pub fn oldest_available_seq(&self) -> u64 {
        self.total_written - self.buf.len() as u64
    }

    /// Bytes currently buffered (for observability / tests).
    #[cfg(test)]
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }

    /// Read the slice of bytes that would bring a client with
    /// `after_seq` up to the current `total_written`. See
    /// [`ReplaySlice`] for the result shape.
    pub fn replay_after(&self, after_seq: u64) -> ReplaySlice {
        if after_seq > self.total_written {
            return ReplaySlice::Future;
        }
        if after_seq == self.total_written {
            return ReplaySlice::UpToDate {
                end_seq: self.total_written,
            };
        }
        let oldest = self.oldest_available_seq();
        if after_seq < oldest {
            // Gap: client's resume point is older than our ring
            // contents. Return everything we have and flag the
            // gap.
            return ReplaySlice::Gap {
                available_from_seq: oldest,
                data: self.buf.iter().copied().collect(),
                end_seq: self.total_written,
            };
        }
        // after_seq is in [oldest, total_written). Skip the
        // prefix and collect the rest.
        let skip = (after_seq - oldest) as usize;
        let data: Vec<u8> = self.buf.iter().copied().skip(skip).collect();
        ReplaySlice::InRange {
            data,
            end_seq: self.total_written,
        }
    }
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_ring_is_zero_everything() {
        let r = RingBuffer::with_capacity(16);
        assert_eq!(r.total_written(), 0);
        assert_eq!(r.oldest_available_seq(), 0);
        assert_eq!(r.buffered_len(), 0);
    }

    #[test]
    fn append_within_capacity_preserves_bytes() {
        let mut r = RingBuffer::with_capacity(16);
        r.append(b"hello");
        assert_eq!(r.total_written(), 5);
        assert_eq!(r.oldest_available_seq(), 0);
        match r.replay_after(0) {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"hello");
                assert_eq!(end_seq, 5);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[test]
    fn append_beyond_capacity_keeps_tail() {
        let mut r = RingBuffer::with_capacity(4);
        r.append(b"abcdef"); // 6 bytes into 4-cap ring
        assert_eq!(r.total_written(), 6);
        assert_eq!(r.oldest_available_seq(), 2);
        assert_eq!(r.buffered_len(), 4);
        match r.replay_after(2) {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"cdef");
                assert_eq!(end_seq, 6);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[test]
    fn append_then_append_crosses_capacity_boundary() {
        let mut r = RingBuffer::with_capacity(4);
        r.append(b"ab");
        r.append(b"cdef");
        // Second append: existing 2 + new 4 = 6; evict 2 from
        // front. Ring is "cdef".
        assert_eq!(r.total_written(), 6);
        assert_eq!(r.oldest_available_seq(), 2);
        match r.replay_after(2) {
            ReplaySlice::InRange { data, .. } => assert_eq!(data, b"cdef"),
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[test]
    fn replay_after_at_current_is_up_to_date() {
        let mut r = RingBuffer::with_capacity(16);
        r.append(b"abc");
        match r.replay_after(3) {
            ReplaySlice::UpToDate { end_seq } => assert_eq!(end_seq, 3),
            other => panic!("expected UpToDate, got {other:?}"),
        }
    }

    #[test]
    fn replay_after_future_is_protocol_error() {
        let mut r = RingBuffer::with_capacity(16);
        r.append(b"abc");
        // Client claims seq 100; we only have 3.
        assert_eq!(r.replay_after(100), ReplaySlice::Future);
    }

    #[test]
    fn replay_after_below_oldest_returns_gap_with_full_contents() {
        let mut r = RingBuffer::with_capacity(4);
        r.append(b"abcdef"); // oldest = 2, total = 6
        match r.replay_after(0) {
            ReplaySlice::Gap {
                available_from_seq,
                data,
                end_seq,
            } => {
                assert_eq!(available_from_seq, 2);
                assert_eq!(end_seq, 6);
                assert_eq!(data, b"cdef");
            }
            other => panic!("expected Gap, got {other:?}"),
        }
    }

    #[test]
    fn replay_after_exactly_at_oldest_is_in_range_empty() {
        // Edge: after_seq == oldest_available means the client
        // asked for "everything after byte N", and byte N is the
        // last one they already had. We return the full ring
        // contents.
        let mut r = RingBuffer::with_capacity(4);
        r.append(b"abcdef"); // oldest = 2
        match r.replay_after(2) {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"cdef");
                assert_eq!(end_seq, 6);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[test]
    fn single_huge_append_keeps_only_tail() {
        // One-shot paste larger than capacity: we don't even
        // allocate capacity for the full paste; existing contents
        // are fully overwritten.
        let mut r = RingBuffer::with_capacity(4);
        r.append(b"x"); // prime with one byte
        let huge = vec![b'A'; 100];
        r.append(&huge);
        assert_eq!(r.total_written(), 101);
        assert_eq!(r.oldest_available_seq(), 97);
        match r.replay_after(97) {
            ReplaySlice::InRange { data, .. } => assert_eq!(data.len(), 4),
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[test]
    fn empty_append_is_noop() {
        let mut r = RingBuffer::with_capacity(16);
        r.append(b"");
        assert_eq!(r.total_written(), 0);
        assert_eq!(r.oldest_available_seq(), 0);
    }
}
