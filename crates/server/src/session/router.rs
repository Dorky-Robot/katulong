//! Dispatcher from the single global tmux `%output` stream to
//! per-connection output pumps, with per-pane history for
//! reconnect replay (slice 9g) and multi-device fan-out (slice
//! 9h).
//!
//! One tmux subprocess produces notifications for every pane on
//! every session it hosts. A per-connection handler only cares
//! about ONE pane (the one its `Attach` bound). The router is
//! the thin indirection that routes a `%output <pane_id> <data>`
//! notification to the right subscribers without forcing each
//! handler to filter the whole stream itself.
//!
//! # Per-pane seq and the reconnect path (slice 9g)
//!
//! Each pane maintains:
//! - An octal [`OctalDecoder`] whose carry survives subscriber
//!   handoffs (the carry is about the tmux byte stream, not the
//!   subscriber).
//! - A byte [`RingBuffer`] (default 256 KiB), tagged with a
//!   monotonic `total_written` that doubles as the wire `seq`.
//! - Zero-or-more active subscriber senders.
//!
//! `dispatch` decodes bytes, appends to the ring, wraps the
//! result in `Arc<OutputChunk>`, and fans it out to every
//! registered subscriber. The ring keeps bytes past each
//! subscriber's wire buffer, so a client that drops and
//! reconnects with `subscribe_with_resume(pane_id, after_seq)`
//! gets a [`ReplaySlice`] describing what to hand the client
//! before going live.
//!
//! Seq is **per-pane, not per-subscriber or per-connection**:
//! two subscribers on the same pane see the same seq sequence
//! at the same time, and a reconnecting client picks up the
//! same counter the prior subscriber was tracking.
//!
//! # Multi-device fan-out (slice 9h)
//!
//! Pre-9h the router allowed at most one subscriber per pane:
//! a second subscribe would DISPLACE the first, matching the
//! "attach-displaces-prior" UX. That got the common "close tab,
//! reopen" flow right but made the genuine multi-device case
//! (phone + laptop connected simultaneously) unworkable — one
//! device would silently kick the other.
//!
//! Slice 9h lifts that restriction: a pane can hold up to
//! [`MAX_SUBSCRIBERS_PER_PANE`] concurrent subscribers. Each
//! gets a [`SubscriberId`] returned from `subscribe` so the
//! handler can later clean itself up without affecting the
//! others. Dispatch fans out the same byte stream to every
//! subscriber via `Arc<OutputChunk>` (one allocation per
//! dispatch regardless of subscriber count).
//!
//! Decisions made explicit:
//! - **Input from multiple devices is serialised by tmux.** Two
//!   clients typing at the same time both forward their bytes
//!   via `SessionManager::send_input`, which writes to tmux's
//!   stdin one command at a time. Interleaving is at the
//!   tmux-command level, which for keystrokes is the correct
//!   granularity (a multi-byte paste on one device doesn't get
//!   split by another device's Ctrl-C).
//! - **Resize still last-writer-wins on the tmux-one-size
//!   constraint.** `CLAUDE.md` is explicit: "A tmux pane has
//!   exactly one terminal size." Two devices with different
//!   window sizes will fight; this is a PTY-structural
//!   limitation and not something we can solve at the
//!   router layer. Users with different sizes should use
//!   separate tmux sessions.
//! - **Backpressure is per-subscriber.** When one subscriber's
//!   queue fills, we drop THAT subscriber's bytes only; other
//!   subscribers on the same pane keep receiving. The dropped
//!   subscriber can still reconnect with resume_from_seq and
//!   pull the missed bytes from the ring.
//! - **Closed-receiver pruning happens during dispatch.**
//!   Subscribers whose receiver got dropped without calling
//!   `clear_subscriber` are pruned on the next fan-out.
//!
//! # Ownership model
//!
//! `OutputRouter` is cheap to clone — internals are `Arc`. The
//! dispatcher task spawned via [`OutputRouter::spawn_dispatcher`]
//! holds one clone and calls [`OutputRouter::dispatch`] for every
//! `%output` notification. Each WS connection handler holds
//! another clone via `AppState` and calls [`OutputRouter::subscribe`]
//! (fresh attach) or [`OutputRouter::subscribe_with_resume`]
//! (reconnect) after its `Attach` succeeds.

use crate::session::output::OctalDecoder;
use crate::session::parser::Notification;
use crate::session::ring::{ReplaySlice, RingBuffer};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Per-pane queue capacity for each subscriber. Tmux emits one
/// `%output` per I/O boundary; a single TUI frame is typically
/// 1–10 chunks, and the handler drains each chunk into a
/// coalescer in constant time. 256 gives generous headroom
/// above any realistic burst without committing huge memory
/// per subscriber.
const PER_PANE_BUFFER: usize = 256;

/// Cap on concurrent subscribers per pane. A single user
/// opening the terminal on phone + laptop + tablet + a few
/// browser tabs shouldn't get anywhere near this. Higher
/// numbers are almost certainly a bug or a deliberate probe;
/// rejecting them keeps memory bounded under misuse.
pub const MAX_SUBSCRIBERS_PER_PANE: usize = 16;

/// Identifier for a registered subscriber. Monotonically
/// increasing per-router; overflow is not a practical concern
/// at single-user scale. Returned from `subscribe` so the
/// handler can `clear_subscriber(pane_id, id)` specifically
/// its own sender without touching siblings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SubscriberId(u64);

impl SubscriberId {
    /// Exposed for the test harness; not intended for
    /// production callers, who should only ever use IDs they
    /// received from `subscribe` / `subscribe_with_resume`.
    #[cfg(test)]
    pub fn testing(raw: u64) -> Self {
        Self(raw)
    }
}

/// Error from [`OutputRouter::subscribe`] /
/// [`OutputRouter::subscribe_with_resume`] when the pane
/// already has `MAX_SUBSCRIBERS_PER_PANE` active subscribers.
/// Callers should surface this to the client as
/// `session_oversubscribed` and close the new connection.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum SubscribeError {
    #[error(
        "pane %{pane_id} already has {active} subscribers; \
         maximum is {max}"
    )]
    Oversubscribed {
        pane_id: u32,
        active: usize,
        max: usize,
    },
}

/// A decoded output chunk with the byte-offset `seq` at which
/// it ends. Subscribers track the highest `end_seq` they've
/// seen; when the coalescer flushes, that value goes into the
/// outbound `ServerMessage::Output.seq`.
///
/// Wrapped in `Arc` for fan-out: one allocation per dispatch
/// is shared across all subscribers regardless of count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputChunk {
    pub data: Vec<u8>,
    /// `total_written` on the pane's ring AFTER appending `data`.
    /// I.e., the seq of the last byte in this chunk, 1-based.
    pub end_seq: u64,
}

/// Router between the global tmux notification stream and the
/// per-pane subscribers. See the module doc.
#[derive(Clone, Default)]
pub struct OutputRouter {
    inner: Arc<Mutex<HashMap<u32, PaneState>>>,
    next_subscriber_id: Arc<AtomicU64>,
}

struct Subscriber {
    id: SubscriberId,
    sender: mpsc::Sender<Arc<OutputChunk>>,
}

struct PaneState {
    subscribers: Vec<Subscriber>,
    decoder: OctalDecoder,
    ring: RingBuffer,
}

impl PaneState {
    fn new() -> Self {
        Self {
            subscribers: Vec::new(),
            decoder: OctalDecoder::new(),
            ring: RingBuffer::new(),
        }
    }
}

impl OutputRouter {
    pub fn new() -> Self {
        Self::default()
    }

    fn mint_id(&self) -> SubscriberId {
        SubscriberId(self.next_subscriber_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Subscribe to `pane_id`'s decoded byte stream for a fresh
    /// attach (no resume). Returns `(receiver, subscriber_id,
    /// baseline_seq)` so the handler can (a) hand its
    /// `subscriber_id` to `clear_subscriber` at cleanup, (b)
    /// echo `baseline_seq` in `Attached.last_seq`.
    ///
    /// Fails if the pane already has [`MAX_SUBSCRIBERS_PER_PANE`]
    /// active subscribers. Returns `SubscribeError::Oversubscribed`;
    /// caller closes the connection with `session_oversubscribed`.
    pub fn subscribe(
        &self,
        pane_id: u32,
    ) -> Result<(mpsc::Receiver<Arc<OutputChunk>>, SubscriberId, u64), SubscribeError> {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        if state.subscribers.len() >= MAX_SUBSCRIBERS_PER_PANE {
            return Err(SubscribeError::Oversubscribed {
                pane_id,
                active: state.subscribers.len(),
                max: MAX_SUBSCRIBERS_PER_PANE,
            });
        }
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        let id = self.mint_id();
        state.subscribers.push(Subscriber { id, sender: tx });
        Ok((rx, id, state.ring.total_written()))
    }

    /// Subscribe AND resume — atomic snapshot + append under
    /// the router lock. Returns the receiver, subscriber id, and
    /// the [`ReplaySlice`] describing what was missed.
    ///
    /// Oversubscribed panes reject the same way as `subscribe`.
    pub fn subscribe_with_resume(
        &self,
        pane_id: u32,
        after_seq: u64,
    ) -> Result<
        (mpsc::Receiver<Arc<OutputChunk>>, SubscriberId, ReplaySlice),
        SubscribeError,
    > {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        if state.subscribers.len() >= MAX_SUBSCRIBERS_PER_PANE {
            return Err(SubscribeError::Oversubscribed {
                pane_id,
                active: state.subscribers.len(),
                max: MAX_SUBSCRIBERS_PER_PANE,
            });
        }
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        let id = self.mint_id();
        let replay = state.ring.replay_after(after_seq);
        state.subscribers.push(Subscriber { id, sender: tx });
        Ok((rx, id, replay))
    }

    /// Read-only snapshot of what [`OutputRouter::subscribe_with_resume`]
    /// would return, WITHOUT installing a subscriber or creating
    /// a pane entry. Used by the handler to validate a client's
    /// `resume_from_seq` before committing the new subscriber —
    /// a version-skew client claiming a future-seq would
    /// otherwise consume one of the subscriber slots on its way
    /// to being rejected.
    ///
    /// If the pane has no entry yet, returns `ReplaySlice` as
    /// if the ring were empty (`total_written == 0`).
    pub fn peek_resume(&self, pane_id: u32, after_seq: u64) -> ReplaySlice {
        let panes = self.inner.lock().expect("output-router mutex poisoned");
        match panes.get(&pane_id) {
            Some(state) => state.ring.replay_after(after_seq),
            None => {
                if after_seq == 0 {
                    ReplaySlice::UpToDate { end_seq: 0 }
                } else {
                    ReplaySlice::Future
                }
            }
        }
    }

    /// Remove THIS subscriber's sender from the pane's
    /// fan-out list. Other subscribers on the same pane keep
    /// receiving. The pane's ring and decoder survive too —
    /// they're per-pane, not per-subscriber, and a future
    /// reconnect (same or different device) gets the
    /// accumulated history via resume.
    ///
    /// Safe to call when the `SubscriberId` is no longer
    /// registered (already pruned by a dispatch after the
    /// receiver was dropped; already cleared by a prior call).
    pub fn clear_subscriber(&self, pane_id: u32, id: SubscriberId) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        if let Some(state) = panes.get_mut(&pane_id) {
            state.subscribers.retain(|s| s.id != id);
        }
    }

    /// Explicitly remove a pane's entry, wiping ring + decoder
    /// plus all subscribers. Call when the underlying tmux pane
    /// is known to be gone (e.g., session destroyed), not for
    /// transport disconnects. Slice 9h+ will wire this to
    /// tmux-pane-close notifications.
    pub fn evict(&self, pane_id: u32) {
        let _ = self
            .inner
            .lock()
            .expect("output-router mutex poisoned")
            .remove(&pane_id);
    }

    /// Route a raw `%output <pane_id> <data>` notification.
    /// Decodes octal escapes, appends to the pane's ring, and
    /// fans the decoded bytes out to every registered
    /// subscriber. Subscribers whose receiver was dropped
    /// without `clear_subscriber` are pruned on the way; those
    /// whose queue is full drop the chunk but stay subscribed
    /// (they can catch up via resume later).
    ///
    /// One allocation per dispatch regardless of subscriber
    /// count — `OutputChunk` wraps in `Arc` for the fan-out.
    pub fn dispatch(&self, pane_id: u32, raw: &str) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        let decoded = state.decoder.decode(raw);
        if decoded.is_empty() {
            return;
        }
        state.ring.append(&decoded);
        let end_seq = state.ring.total_written();
        let chunk = Arc::new(OutputChunk {
            data: decoded,
            end_seq,
        });
        state.subscribers.retain(|sub| {
            match sub.sender.try_send(Arc::clone(&chunk)) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    tracing::warn!(
                        pane_id,
                        subscriber = ?sub.id,
                        "output dispatch dropped — subscriber queue full (ring retains)"
                    );
                    true
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    tracing::trace!(
                        pane_id,
                        subscriber = ?sub.id,
                        "pruning subscriber whose receiver was dropped"
                    );
                    false
                }
            }
        });
    }

    /// Spawn the dispatcher task. See module doc.
    pub fn spawn_dispatcher(
        &self,
        mut notifs: mpsc::UnboundedReceiver<Notification>,
    ) -> JoinHandle<()> {
        let router = self.clone();
        tokio::spawn(async move {
            while let Some(notif) = notifs.recv().await {
                match notif {
                    Notification::Output { pane_id, data } => {
                        router.dispatch(pane_id, &data);
                    }
                    Notification::Exit { reason } => {
                        tracing::warn!(?reason, "tmux control-mode exited");
                        break;
                    }
                    other => {
                        tracing::trace!(?other, "tmux notification (no consumer yet)");
                    }
                }
            }
        })
    }

    /// Number of currently-registered panes. Test-only.
    #[cfg(test)]
    pub fn registered_count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// Number of active subscribers on a pane. Test-only.
    #[cfg(test)]
    pub fn subscriber_count(&self, pane_id: u32) -> usize {
        self.inner
            .lock()
            .unwrap()
            .get(&pane_id)
            .map_or(0, |s| s.subscribers.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- Single-subscriber parity (carried forward from 9g) ----------

    #[tokio::test]
    async fn subscribe_returns_zero_seq_on_empty_pane() {
        let r = OutputRouter::new();
        let (_rx, _id, seq) = r.subscribe(0).unwrap();
        assert_eq!(seq, 0);
    }

    #[tokio::test]
    async fn dispatch_delivers_output_chunk_with_end_seq() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, "hello");
        let got = rx.recv().await.expect("bytes arrive");
        assert_eq!(got.data, b"hello");
        assert_eq!(got.end_seq, 5);
    }

    #[tokio::test]
    async fn consecutive_dispatches_produce_monotonic_seqs() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, "ab");
        r.dispatch(0, "cd");
        let c1 = rx.recv().await.unwrap();
        let c2 = rx.recv().await.unwrap();
        assert_eq!(c1.end_seq, 2);
        assert_eq!(c2.end_seq, 4);
    }

    #[tokio::test]
    async fn dispatch_decodes_octal() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(7).unwrap();
        r.dispatch(7, r"\033[2J");
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, &[0x1B, b'[', b'2', b'J']);
    }

    #[tokio::test]
    async fn dispatch_carries_partial_escape_across_calls() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, r"\342\226\2");
        r.dispatch(0, "10");
        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        let mut combined = first.data.clone();
        combined.extend(&second.data);
        assert_eq!(combined, &[0xE2, 0x96, 0x88]);
    }

    #[tokio::test]
    async fn subscribe_with_resume_returns_in_range_bytes() {
        let r = OutputRouter::new();
        r.dispatch(0, "abcde");
        let (mut rx, _id, replay) = r.subscribe_with_resume(0, 2).unwrap();
        match replay {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"cde");
                assert_eq!(end_seq, 5);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
        r.dispatch(0, "fg");
        let chunk = rx.recv().await.unwrap();
        assert_eq!(chunk.data, b"fg");
        assert_eq!(chunk.end_seq, 7);
    }

    #[tokio::test]
    async fn subscribe_with_resume_up_to_date() {
        let r = OutputRouter::new();
        r.dispatch(0, "abc");
        let (_rx, _id, replay) = r.subscribe_with_resume(0, 3).unwrap();
        assert_eq!(replay, ReplaySlice::UpToDate { end_seq: 3 });
    }

    #[tokio::test]
    async fn subscribe_with_resume_future_is_protocol_error_slice() {
        let r = OutputRouter::new();
        r.dispatch(0, "abc");
        let (_rx, _id, replay) = r.subscribe_with_resume(0, 999).unwrap();
        assert_eq!(replay, ReplaySlice::Future);
    }

    #[tokio::test]
    async fn subscribe_with_resume_gap_returns_current_window() {
        let r = OutputRouter::new();
        for _ in 0..(crate::session::ring::DEFAULT_CAPACITY / 64 + 4) {
            r.dispatch(0, &"x".repeat(64));
        }
        let (_rx, _id, replay) = r.subscribe_with_resume(0, 0).unwrap();
        match replay {
            ReplaySlice::Gap {
                available_from_seq,
                data: _,
                end_seq: _,
            } => assert!(available_from_seq > 0),
            other => panic!("expected Gap, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn clear_subscriber_keeps_ring_for_reconnect() {
        let r = OutputRouter::new();
        let (_rx, id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, "abc");
        r.clear_subscriber(0, id);
        let (_rx2, _id2, baseline) = r.subscribe(0).unwrap();
        assert_eq!(
            baseline, 3,
            "clear_subscriber keeps ring for reconnect-replay"
        );
    }

    #[tokio::test]
    async fn evict_removes_pane_entirely() {
        let r = OutputRouter::new();
        let (_rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, "doomed");
        r.evict(0);
        let (_rx2, _id2, baseline) = r.subscribe(0).unwrap();
        assert_eq!(baseline, 0);
    }

    #[tokio::test]
    async fn clear_subscriber_unknown_id_is_noop() {
        // An already-pruned sub or a stale id from a different
        // pane must not panic or corrupt state.
        let r = OutputRouter::new();
        r.clear_subscriber(99, SubscriberId::testing(9999));
        let (_rx, id, _) = r.subscribe(1).unwrap();
        r.clear_subscriber(1, id);
        r.clear_subscriber(1, id); // second clear: no-op
    }

    #[tokio::test]
    async fn dispatch_with_no_prior_subscriber_seeds_ring() {
        let r = OutputRouter::new();
        r.dispatch(42, "prompt$ ");
        let (_rx, _id, baseline) = r.subscribe(42).unwrap();
        assert_eq!(baseline, 8);
    }

    #[tokio::test]
    async fn router_clones_share_state() {
        let r1 = OutputRouter::new();
        let r2 = r1.clone();
        let (mut rx, _id, _) = r1.subscribe(0).unwrap();
        r2.dispatch(0, "cross");
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, b"cross");
    }

    #[tokio::test]
    async fn carry_only_output_does_not_dispatch_or_seq_advance() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, r"\");
        assert!(rx.try_recv().is_err());
        let (_rx2, _id2, seq) = r.subscribe(0).unwrap();
        assert_eq!(seq, 0);
    }

    #[tokio::test]
    async fn peek_resume_does_not_displace_subscribers() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        r.dispatch(0, "live");
        let _ = r.peek_resume(0, 999_999);
        let got = rx.recv().await.expect("subscriber survived peek");
        assert_eq!(got.data, b"live");
    }

    #[tokio::test]
    async fn peek_resume_on_empty_pane_with_after_zero_is_uptodate() {
        let r = OutputRouter::new();
        assert_eq!(
            r.peek_resume(42, 0),
            ReplaySlice::UpToDate { end_seq: 0 }
        );
    }

    #[tokio::test]
    async fn peek_resume_on_empty_pane_with_nonzero_is_future() {
        let r = OutputRouter::new();
        assert_eq!(r.peek_resume(42, 100), ReplaySlice::Future);
    }

    // ---------- Multi-device fan-out (slice 9h) ----------

    #[tokio::test]
    async fn two_subscribers_both_receive_the_same_bytes() {
        // Core claim of slice 9h: a phone and a laptop attached
        // to the same pane each see the stream, without one
        // kicking the other.
        let r = OutputRouter::new();
        let (mut phone, _p_id, _) = r.subscribe(0).unwrap();
        let (mut laptop, _l_id, _) = r.subscribe(0).unwrap();
        assert_eq!(r.subscriber_count(0), 2);

        r.dispatch(0, "shared");
        let pc = phone.recv().await.unwrap();
        let lc = laptop.recv().await.unwrap();
        assert_eq!(pc.data, b"shared");
        assert_eq!(lc.data, b"shared");
        // Both point at the same Arc; verify by seq
        // (Arc::ptr_eq would also work, but seq equality is
        // the user-facing contract that matters).
        assert_eq!(pc.end_seq, lc.end_seq);
    }

    #[tokio::test]
    async fn dropped_subscriber_does_not_affect_siblings() {
        // Regression guard: dropping one subscriber's receiver
        // must not break dispatch for the others. Prior single-
        // subscriber design prevented this question from
        // existing; multi-device raises it.
        let r = OutputRouter::new();
        let (phone, _p_id, _) = r.subscribe(0).unwrap();
        let (mut laptop, _l_id, _) = r.subscribe(0).unwrap();
        drop(phone); // phone tab closed without calling clear_subscriber

        r.dispatch(0, "after-drop");
        let got = laptop.recv().await.expect("laptop still receives");
        assert_eq!(got.data, b"after-drop");
        // Phone's sub got pruned during the dispatch.
        assert_eq!(r.subscriber_count(0), 1);
    }

    #[tokio::test]
    async fn clear_subscriber_removes_only_named_subscriber() {
        let r = OutputRouter::new();
        let (mut phone, phone_id, _) = r.subscribe(0).unwrap();
        let (mut laptop, _l_id, _) = r.subscribe(0).unwrap();

        r.clear_subscriber(0, phone_id);
        assert_eq!(r.subscriber_count(0), 1);

        r.dispatch(0, "laptop-only");
        // Phone's mpsc closed by clear_subscriber dropping its
        // sender.
        assert!(phone.recv().await.is_none());
        let got = laptop.recv().await.unwrap();
        assert_eq!(got.data, b"laptop-only");
    }

    #[tokio::test]
    async fn over_cap_subscribe_is_rejected() {
        let r = OutputRouter::new();
        let mut receivers = Vec::new();
        for _ in 0..MAX_SUBSCRIBERS_PER_PANE {
            let (rx, _id, _) = r.subscribe(0).unwrap();
            receivers.push(rx);
        }
        let err = r.subscribe(0).unwrap_err();
        match err {
            SubscribeError::Oversubscribed {
                pane_id,
                active,
                max,
            } => {
                assert_eq!(pane_id, 0);
                assert_eq!(active, MAX_SUBSCRIBERS_PER_PANE);
                assert_eq!(max, MAX_SUBSCRIBERS_PER_PANE);
            }
        }
        // The cap must not invalidate existing subscriptions.
        assert_eq!(r.subscriber_count(0), MAX_SUBSCRIBERS_PER_PANE);
    }

    #[tokio::test]
    async fn over_cap_rejection_does_not_create_pane_allocation_without_room() {
        // A caller hitting the cap must not inflate the map or
        // mint a subscriber id — the reject path is fully
        // read-only.
        let r = OutputRouter::new();
        let _keep: Vec<_> = (0..MAX_SUBSCRIBERS_PER_PANE)
            .map(|_| r.subscribe(0).unwrap().0)
            .collect();
        let before = r.subscriber_count(0);
        let _ = r.subscribe(0).unwrap_err();
        assert_eq!(r.subscriber_count(0), before);
    }

    #[tokio::test]
    async fn subscriber_ids_are_unique_across_panes() {
        let r = OutputRouter::new();
        let (_a, ida, _) = r.subscribe(0).unwrap();
        let (_b, idb, _) = r.subscribe(1).unwrap();
        let (_c, idc, _) = r.subscribe(0).unwrap();
        assert_ne!(ida, idb);
        assert_ne!(ida, idc);
        assert_ne!(idb, idc);
    }

    #[tokio::test]
    async fn resume_after_displacement_picks_up_from_siblings_seq() {
        // Device A connects; dispatches happen; device A loses
        // connection; A reconnects with its last seq; with
        // fan-out the sibling (device B) has been receiving
        // the same stream, so A's resume covers exactly the
        // bytes A missed while its transport was down.
        let r = OutputRouter::new();
        let (mut a, a_id, _) = r.subscribe(0).unwrap();
        let (mut b, _b_id, _) = r.subscribe(0).unwrap();

        r.dispatch(0, "aa"); // both see
        let _ = a.recv().await; // A consumed through seq 2
        let _ = b.recv().await;

        // A's "connection drops" — clear it explicitly.
        r.clear_subscriber(0, a_id);

        r.dispatch(0, "bb"); // only B sees (live)
        let _ = b.recv().await;

        // A reconnects with resume_from_seq = 2.
        let (_a2, _id, replay) = r.subscribe_with_resume(0, 2).unwrap();
        match replay {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"bb", "A should replay exactly what it missed");
                assert_eq!(end_seq, 4);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn spawn_dispatcher_routes_output_and_exits_on_tmux_exit() {
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(3).unwrap();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs);

        tx.send(Notification::Output {
            pane_id: 3,
            data: "ping".into(),
        })
        .unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, b"ping");

        tx.send(Notification::Exit {
            reason: Some("test".into()),
        })
        .unwrap();
        handle.await.expect("dispatcher task joins cleanly");
    }

    #[tokio::test]
    async fn spawn_dispatcher_exits_when_notifs_closes() {
        let r = OutputRouter::new();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs);
        drop(tx);
        handle.await.expect("dispatcher exits on sender drop");
    }
}
