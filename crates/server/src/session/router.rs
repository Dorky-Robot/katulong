//! Dispatcher from the single global tmux `%output` stream to
//! per-connection output pumps, with per-pane history for
//! reconnect replay (slice 9g).
//!
//! One tmux subprocess produces notifications for every pane on
//! every session it hosts. A per-connection handler only cares
//! about ONE pane (the one its `Attach` bound). The router is
//! the thin indirection that routes a `%output <pane_id> <data>`
//! notification to the right subscriber without forcing every
//! handler to filter the whole stream itself.
//!
//! # Per-pane seq and the reconnect path (slice 9g)
//!
//! Each pane maintains:
//! - An octal [`OctalDecoder`] whose carry survives subscriber
//!   handoffs (the carry is about the tmux byte stream, not the
//!   subscriber).
//! - A byte [`RingBuffer`] of the last ~64 KiB, tagged with a
//!   monotonic `total_written` that doubles as the wire `seq`.
//! - The current subscriber's [`mpsc::Sender`], if any.
//!
//! `dispatch` decodes bytes, appends to the ring, and pushes an
//! [`OutputChunk`] (`data` + `end_seq`) to the subscriber. The
//! ring keeps bytes past the subscriber's wire buffer, so a
//! client that drops and reconnects with
//! `subscribe_with_resume(pane_id, after_seq)` gets a
//! [`ReplaySlice`] describing what to hand the client before
//! going live.
//!
//! The seq semantics are **per-pane, not per-connection**: two
//! successive subscribers on the same pane see contiguous seqs,
//! which is what makes the reconnect path useful. Pre-9g the
//! docstring said "per-connection monotonic" — that's obsolete.
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
//!
//! # Attach-displaces-prior semantics (slice 9f)
//!
//! Subscribing always succeeds. If a prior subscriber already
//! held the pane, their `mpsc::Receiver` sees its channel close
//! on the next `recv()` and the handler's loop treats that as
//! `Action::Exit`. This matches katulong's one-user-many-devices
//! model: opening the app in a second browser tab smoothly takes
//! over the terminal. Slice 9h revisits this when multi-device
//! fan-out lands.
//!
//! # Backpressure
//!
//! The per-pane mpsc channel has a bounded capacity
//! (`PER_PANE_BUFFER`). If the subscriber's handler falls behind,
//! `try_send` fails and the dispatcher DROPS the bytes with a
//! `warn!` log. Output loss is visible to the user as a terminal
//! glitch, but the alternative — blocking the tmux reader task
//! on one slow client — starves every other pane's output. The
//! ring buffer still captures the dropped bytes, so a reconnect
//! after a drop can resume cleanly via the gap path.

use crate::session::output::OctalDecoder;
use crate::session::parser::Notification;
use crate::session::ring::{ReplaySlice, RingBuffer};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// Per-pane queue capacity. Tmux emits one `%output` per I/O
/// boundary; a single TUI frame is typically 1–10 chunks, and
/// the handler drains each chunk into a coalescer in constant
/// time. 256 gives a generous headroom above any realistic burst
/// without committing huge memory (each entry is a small `Vec`).
const PER_PANE_BUFFER: usize = 256;

/// A decoded output chunk with the byte-offset `seq` at which
/// it ends. Subscribers track the highest `end_seq` they've
/// seen; when the coalescer flushes, that value goes into the
/// outbound `ServerMessage::Output.seq`.
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
}

struct PaneState {
    sender: Option<mpsc::Sender<OutputChunk>>,
    decoder: OctalDecoder,
    ring: RingBuffer,
}

impl PaneState {
    fn new() -> Self {
        Self {
            sender: None,
            decoder: OctalDecoder::new(),
            ring: RingBuffer::new(),
        }
    }
}

impl OutputRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to `pane_id`'s decoded byte stream for a fresh
    /// attach (no resume). Always succeeds — if a prior
    /// subscriber is already registered, their sender is dropped
    /// (their `recv` yields `None` → old handler exits via
    /// `Action::Exit`) and the new subscriber takes over. The
    /// decoder's carry buffer AND the ring survive the swap
    /// because they're per-pane, not per-subscriber.
    ///
    /// Returns `(receiver, current_seq)` so the handler can echo
    /// `current_seq` in its `Attached` response. The client
    /// watches the seq progression from there.
    pub fn subscribe(&self, pane_id: u32) -> (mpsc::Receiver<OutputChunk>, u64) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        state.sender = Some(tx);
        (rx, state.ring.total_written())
    }

    /// Subscribe AND resume — do both atomically under the
    /// router's lock so nothing slips in between snapshot and
    /// subscribe. Returns the receiver (for the live stream
    /// going forward from the snapshot point) plus a
    /// [`ReplaySlice`] describing what the client missed.
    ///
    /// The handler hands the replay bytes to the client BEFORE
    /// draining the receiver, so from the client's perspective
    /// bytes arrive in strict seq order without overlap.
    ///
    /// If `pane_id` isn't in the map yet, we insert it fresh
    /// (empty ring → replay is `UpToDate` at seq 0).
    pub fn subscribe_with_resume(
        &self,
        pane_id: u32,
        after_seq: u64,
    ) -> (mpsc::Receiver<OutputChunk>, ReplaySlice) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        let replay = state.ring.replay_after(after_seq);
        state.sender = Some(tx);
        (rx, replay)
    }

    /// Remove a pane's registration. Drops the sender, decoder,
    /// and ring. Safe to call when no subscriber is registered
    /// (no-op). Handlers MUST call this on clean exit.
    pub fn unsubscribe(&self, pane_id: u32) {
        let _ = self
            .inner
            .lock()
            .expect("output-router mutex poisoned")
            .remove(&pane_id);
    }

    /// Route a raw `%output <pane_id> <data>` notification.
    /// Decodes octal escapes, appends the decoded bytes to the
    /// pane's ring, and forwards an [`OutputChunk`] to the
    /// subscriber (if any).
    ///
    /// If the pane isn't registered yet, we create a fresh
    /// `PaneState` (empty ring, no sender) and append. This
    /// means the ring accumulates history even before a client
    /// first attaches — a client attaching to an existing
    /// session will see whatever's already there. For 9g this
    /// means the first Attach gets fresh state; for later
    /// slices with long-lived tmux sessions, clients reconnect
    /// into scrollback organically.
    ///
    /// Input `raw` is expected to be tmux control-mode-encoded
    /// text.
    pub fn dispatch(&self, pane_id: u32, raw: &str) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let state = panes.entry(pane_id).or_insert_with(PaneState::new);
        let decoded = state.decoder.decode(raw);
        if decoded.is_empty() {
            // Entire chunk absorbed into the carry. Nothing to
            // append or dispatch yet.
            return;
        }
        state.ring.append(&decoded);
        let end_seq = state.ring.total_written();
        let chunk = OutputChunk {
            data: decoded,
            end_seq,
        };
        if let Some(sender) = state.sender.as_ref() {
            match sender.try_send(chunk) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // Subscriber fell behind. Bytes are still in
                    // the ring — a reconnect can recover via
                    // resume. Drop the live chunk with a warn.
                    tracing::warn!(
                        pane_id,
                        "output dispatch dropped — subscriber queue full (ring retains)"
                    );
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    // Subscriber dropped their receiver without
                    // unsubscribe (e.g., handler panic). Clear
                    // the sender; KEEP the ring and decoder so
                    // a reconnect still gets history. The
                    // PaneState itself stays registered.
                    state.sender = None;
                }
            }
        }
    }

    /// Spawn the dispatcher task: a loop that drains `notifs`
    /// (the `mpsc::UnboundedReceiver<Notification>` from
    /// `Tmux::spawn`) and routes each `%output` event through
    /// `dispatch`. Returns the task's `JoinHandle`.
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

    /// Number of currently-registered panes. Test-only; not
    /// exposed in release builds.
    #[cfg(test)]
    pub fn registered_count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_returns_zero_seq_on_empty_pane() {
        let r = OutputRouter::new();
        let (_rx, seq) = r.subscribe(0);
        assert_eq!(seq, 0);
    }

    #[tokio::test]
    async fn dispatch_delivers_output_chunk_with_end_seq() {
        let r = OutputRouter::new();
        let (mut rx, _) = r.subscribe(0);
        r.dispatch(0, "hello");
        let got = rx.recv().await.expect("bytes arrive");
        assert_eq!(got.data, b"hello");
        assert_eq!(got.end_seq, 5);
    }

    #[tokio::test]
    async fn consecutive_dispatches_produce_monotonic_seqs() {
        let r = OutputRouter::new();
        let (mut rx, _) = r.subscribe(0);
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
        let (mut rx, _) = r.subscribe(7);
        r.dispatch(7, r"\033[2J");
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, &[0x1B, b'[', b'2', b'J']);
    }

    #[tokio::test]
    async fn dispatch_carries_partial_escape_across_calls() {
        let r = OutputRouter::new();
        let (mut rx, _) = r.subscribe(0);
        r.dispatch(0, r"\342\226\2");
        r.dispatch(0, "10");
        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        let mut combined = first.data;
        combined.extend(second.data);
        assert_eq!(combined, &[0xE2, 0x96, 0x88]);
    }

    #[tokio::test]
    async fn second_subscribe_displaces_prior_but_preserves_ring() {
        // One-user-many-devices: the second attach takes over.
        // The ring survives the swap so the second subscriber
        // could still request resume if they knew what they
        // missed.
        let r = OutputRouter::new();
        let (mut first, _) = r.subscribe(0);
        r.dispatch(0, "abc"); // first sees it
        let _first_chunk = first.recv().await.unwrap();

        let (mut second, baseline) = r.subscribe(0);
        assert_eq!(baseline, 3, "seq baseline after 3 bytes");
        assert!(
            first.recv().await.is_none(),
            "prior subscription must close when replaced"
        );
        r.dispatch(0, "def");
        let got = second.recv().await.unwrap();
        assert_eq!(got.data, b"def");
        assert_eq!(got.end_seq, 6);
    }

    #[tokio::test]
    async fn subscribe_with_resume_returns_in_range_bytes() {
        let r = OutputRouter::new();
        // Seed the ring before any subscriber exists.
        r.dispatch(0, "abcde");
        let (mut rx, replay) = r.subscribe_with_resume(0, 2);
        match replay {
            ReplaySlice::InRange { data, end_seq } => {
                assert_eq!(data, b"cde");
                assert_eq!(end_seq, 5);
            }
            other => panic!("expected InRange, got {other:?}"),
        }
        // Live continues after the replay snapshot.
        r.dispatch(0, "fg");
        let chunk = rx.recv().await.unwrap();
        assert_eq!(chunk.data, b"fg");
        assert_eq!(chunk.end_seq, 7);
    }

    #[tokio::test]
    async fn subscribe_with_resume_up_to_date() {
        let r = OutputRouter::new();
        r.dispatch(0, "abc");
        let (_rx, replay) = r.subscribe_with_resume(0, 3);
        assert_eq!(replay, ReplaySlice::UpToDate { end_seq: 3 });
    }

    #[tokio::test]
    async fn subscribe_with_resume_future_is_protocol_error() {
        let r = OutputRouter::new();
        r.dispatch(0, "abc");
        let (_rx, replay) = r.subscribe_with_resume(0, 999);
        assert_eq!(replay, ReplaySlice::Future);
    }

    #[tokio::test]
    async fn subscribe_with_resume_gap_returns_current_window() {
        let r = OutputRouter::new();
        // Force a ring rollover by dispatching more than default
        // capacity. Using a small dispatch repeatedly keeps the
        // test fast.
        for _ in 0..(crate::session::ring::DEFAULT_CAPACITY / 64 + 4) {
            r.dispatch(0, &"x".repeat(64));
        }
        let (_rx, replay) = r.subscribe_with_resume(0, 0);
        match replay {
            ReplaySlice::Gap {
                available_from_seq,
                data: _,
                end_seq: _,
            } => {
                assert!(
                    available_from_seq > 0,
                    "gap must report a positive oldest-available seq"
                );
            }
            other => panic!("expected Gap, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unsubscribe_clears_ring() {
        // Explicit clean unsubscribe wipes pane state — a fresh
        // subscribe starts the ring from zero. (Panicked
        // subscriber's half-state keeps the ring; see
        // `dispatch_preserves_ring_on_closed_subscriber`.)
        let r = OutputRouter::new();
        let (_rx, _) = r.subscribe(0);
        r.dispatch(0, "abc");
        r.unsubscribe(0);
        let (_rx2, baseline) = r.subscribe(0);
        assert_eq!(baseline, 0, "unsubscribe wipes ring");
    }

    #[tokio::test]
    async fn dispatch_preserves_ring_on_closed_subscriber() {
        // Handler panic path: receiver dropped without
        // unsubscribe. Next dispatch sees Closed; clears sender
        // but KEEPS the ring + decoder. A reconnect resume can
        // still use the history.
        let r = OutputRouter::new();
        let (rx, _) = r.subscribe(0);
        drop(rx);
        r.dispatch(0, "orphan");
        let (_rx, baseline) = r.subscribe(0);
        assert_eq!(
            baseline, 6,
            "ring must survive subscriber-closed dispatch so reconnect-resume works"
        );
    }

    #[tokio::test]
    async fn dispatch_with_no_prior_subscriber_seeds_ring() {
        // A dispatch before any subscribe creates the pane entry
        // and seeds the ring. This is the "initial tmux session
        // printing a prompt before the first client connects"
        // path. The first subscriber then sees the baseline seq.
        let r = OutputRouter::new();
        r.dispatch(42, "prompt$ ");
        let (_rx, baseline) = r.subscribe(42);
        assert_eq!(baseline, 8);
    }

    #[tokio::test]
    async fn unsubscribe_is_idempotent() {
        let r = OutputRouter::new();
        r.unsubscribe(99); // nothing registered — no-op
        let (_rx, _) = r.subscribe(1);
        r.unsubscribe(1);
        r.unsubscribe(1); // already gone — no-op
    }

    #[tokio::test]
    async fn router_clones_share_state() {
        let r1 = OutputRouter::new();
        let r2 = r1.clone();
        let (mut rx, _) = r1.subscribe(0);
        r2.dispatch(0, "cross");
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, b"cross");
    }

    #[tokio::test]
    async fn carry_only_output_does_not_dispatch_or_seq_advance() {
        // A chunk absorbed into the decoder carry must not emit
        // an OutputChunk AND must not advance the ring (no bytes
        // actually landed). Otherwise seq integrity breaks.
        let r = OutputRouter::new();
        let (mut rx, _) = r.subscribe(0);
        r.dispatch(0, r"\");
        assert!(rx.try_recv().is_err(), "carry-only dispatch sends nothing");
        let (_rx2, seq) = r.subscribe(0);
        assert_eq!(seq, 0, "carry-only must not advance ring");
    }

    #[tokio::test]
    async fn spawn_dispatcher_routes_output_and_exits_on_tmux_exit() {
        let r = OutputRouter::new();
        let (mut rx, _) = r.subscribe(3);
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
