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
use std::collections::{HashMap, HashSet};
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

/// Defense-in-depth cap on distinct panes the router will
/// track. The router's HashMap auto-creates a `PaneState` (with
/// a 256 KiB ring) for any `pane_id` it sees — from tmux
/// `%output` notifications AND from handler `subscribe` /
/// `subscribe_with_resume` calls. Neither side is supposed to
/// produce attacker-controlled `pane_id` values, but a parser
/// bug OR a crafted tmux escape that somehow injects a spurious
/// `%output` line could otherwise grow the map unboundedly. At
/// 128 panes × 256 KiB ring = 32 MiB, which is plenty of
/// headroom for any legitimate single-user katulong workload
/// (the 16-pane dims.rs example uses 4 MiB).
const MAX_PANES: usize = 128;

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
    /// The router is already tracking `MAX_PANES` distinct
    /// panes; creating a new entry for this pane would exceed
    /// the defense-in-depth cap. Fires only for a previously-
    /// unseen `pane_id`; existing panes still accept new
    /// subscribers up to the per-pane cap.
    #[error("router pane capacity reached; cannot register new pane %{pane_id}")]
    RouterAtCapacity { pane_id: u32 },
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

    /// Shared subscribe body. Held by the router lock, runs the
    /// pane-cap + subscriber-cap checks, mints an id, appends a
    /// subscriber, and reads the ring slice corresponding to
    /// `after_seq`. Callers that don't want replay pass
    /// `None` (and get back `ReplaySlice::Fresh`); callers that
    /// do pass `Some(N)` and match on the slice variants.
    ///
    /// Private: callers go through [`OutputRouter::subscribe`] or
    /// [`OutputRouter::subscribe_with_resume`], which share this
    /// body. Keeping them as distinct public methods preserves
    /// the shape of each call at the handler site — fresh attach
    /// vs reconnect — while the shared body catches any future
    /// cap-check or channel-setup drift in one place.
    fn do_subscribe(
        &self,
        pane_id: u32,
        after_seq: Option<u64>,
    ) -> Result<(mpsc::Receiver<Arc<OutputChunk>>, SubscriberId, ReplaySlice), SubscribeError>
    {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        // Pane-namespace cap: reject NEW panes once we're at
        // MAX_PANES. Existing panes still accept subscribers.
        if !panes.contains_key(&pane_id) && panes.len() >= MAX_PANES {
            return Err(SubscribeError::RouterAtCapacity { pane_id });
        }
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
        let replay = match after_seq {
            Some(n) => state.ring.replay_after(n),
            None => ReplaySlice::Fresh {
                end_seq: state.ring.total_written(),
            },
        };
        state.subscribers.push(Subscriber { id, sender: tx });
        Ok((rx, id, replay))
    }

    /// Subscribe to `pane_id`'s decoded byte stream for a fresh
    /// attach (no resume). Returns `(receiver, subscriber_id,
    /// baseline_seq)` so the handler can (a) hand its
    /// `subscriber_id` to `clear_subscriber` at cleanup, (b)
    /// echo `baseline_seq` in `Attached.last_seq`.
    ///
    /// Fails if the pane already has [`MAX_SUBSCRIBERS_PER_PANE`]
    /// active subscribers OR if registering a new pane would
    /// exceed the router's pane-namespace cap.
    pub fn subscribe(
        &self,
        pane_id: u32,
    ) -> Result<(mpsc::Receiver<Arc<OutputChunk>>, SubscriberId, u64), SubscribeError> {
        let (rx, id, replay) = self.do_subscribe(pane_id, None)?;
        let baseline = match replay {
            ReplaySlice::Fresh { end_seq } => end_seq,
            // do_subscribe(None) only ever returns Fresh. The
            // exhaustive match guards against future refactors.
            _ => unreachable!("do_subscribe(None) returns ReplaySlice::Fresh"),
        };
        Ok((rx, id, baseline))
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
        self.do_subscribe(pane_id, Some(after_seq))
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
    /// transport disconnects. Slice 9i reaches this path via
    /// [`OutputRouter::retain_panes`] driven by
    /// `SessionManager::reconcile_router` on tmux
    /// `%window-close` / `%unlinked-window-close` notifications.
    pub fn evict(&self, pane_id: u32) {
        let _ = self
            .inner
            .lock()
            .expect("output-router mutex poisoned")
            .remove(&pane_id);
    }

    /// Evict EVERY registered pane. Called by the dispatcher
    /// task when tmux control-mode exits, so every connected
    /// handler sees its `output_rx` close and wakes to
    /// `Action::Exit` instead of hanging forever on a
    /// `recv().await` that will never resolve.
    ///
    /// Without this, the handlers' `output_rx` channels would
    /// stay alive as long as any `OutputRouter` clone holds the
    /// shared `Arc<Mutex<HashMap>>` (which every handler does
    /// via `AppState`) — the dispatcher dropping its clone
    /// doesn't close the per-pane senders stored inside the
    /// map. Draining the map here drops every `Sender`, which
    /// closes every `Receiver`.
    pub fn evict_all(&self) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let count = panes.len();
        panes.clear();
        if count > 0 {
            tracing::info!(panes = count, "output router evicted all panes");
        }
    }

    /// Retain only the panes whose id is in `keep`; evict the
    /// rest. Returns how many panes were evicted so the caller
    /// can log a single summary line per reconcile pass.
    ///
    /// Intended caller: `SessionManager::reconcile_router`, which
    /// queries tmux for the current set of live pane ids and
    /// hands that set here. Any router-registered pane that tmux
    /// no longer reports is a zombie (its underlying window
    /// closed) and its ring is safe to drop.
    ///
    /// Eviction is the same drop-all-subscribers +
    /// drop-ring-and-decoder path as [`OutputRouter::evict`]:
    /// every subscriber's receiver closes on its next `recv()`,
    /// and their handlers exit via `Action::Exit`. Safe to call
    /// with a `keep` set that contains pane ids the router never
    /// registered — extras are ignored.
    pub fn retain_panes(&self, keep: &HashSet<u32>) -> usize {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let before = panes.len();
        panes.retain(|pane_id, _| keep.contains(pane_id));
        before - panes.len()
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
        // Defense-in-depth: don't auto-create a PaneState for a
        // previously-unseen pane if we're at MAX_PANES. The
        // notification is dropped silently with a rate-limited
        // warn; production tmux never emits pane_ids we haven't
        // already registered via subscribe, so this branch
        // firing is a parser-bug signal.
        if !panes.contains_key(&pane_id) && panes.len() >= MAX_PANES {
            tracing::warn!(
                pane_id,
                panes = panes.len(),
                "dropping %output for unseen pane — router at MAX_PANES"
            );
            return;
        }
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

    /// Spawn the global dispatcher task — **keepalive CM only**.
    /// See module doc.
    ///
    /// This dispatcher handles `%output`, lifecycle events
    /// (`%sessions-changed`, `%window-close`,
    /// `%unlinked-window-close`) that drive reconcile, and
    /// `%exit` that drives [`OutputRouter::evict_all`]. Per-tile
    /// CMs do NOT see lifecycle events (a CM only receives
    /// notifications for the session it's attached to), so this
    /// task must NOT be spawned for per-tile CMs — they'd never
    /// trigger reconcile, and a per-tile `%exit` from a tile-
    /// session-killed event would incorrectly `evict_all`.
    /// Per-tile CMs use [`OutputRouter::spawn_output_pump`]
    /// instead.
    ///
    /// When the task exits (either tmux's `%exit` notification
    /// or the notification sender being dropped), it calls
    /// [`OutputRouter::evict_all`] so every attached handler
    /// sees its `output_rx` close and wakes to a clean
    /// `Action::Exit`. Without this, the per-pane senders would
    /// stay alive as long as any handler held an `OutputRouter`
    /// clone via `AppState` — handlers would freeze on
    /// `output_rx.recv()` waiting for bytes that will never
    /// arrive. A correctness reviewer called this out as a HIGH
    /// bug on the first round of slice 9h; this is the fix.
    ///
    /// # Slice 9i: reconcile on window-close
    ///
    /// On `%window-close` / `%unlinked-window-close`, the
    /// dispatcher fires off `sessions.reconcile_router(&router)`
    /// as a detached tokio task. The reconcile queries tmux for
    /// its current set of live pane ids and evicts any router-
    /// registered pane tmux no longer reports — closing the
    /// long-running-server ring leak path.
    ///
    /// Fire-and-forget is deliberate: reconcile makes a tmux
    /// round-trip, and blocking the notification loop on it
    /// would back-pressure `%output` events behind cleanup
    /// work. A failed reconcile logs and moves on; the next
    /// close event will try again. Multiple reconciles
    /// queueing up is self-compensating — each one is
    /// idempotent (it sets the keep-set, doesn't append to it).
    /// Spawn a per-tile output dispatcher (slice 9n / Path 1).
    /// Consumes `%output` notifications from a single tile's CM
    /// and routes them through [`OutputRouter::dispatch`].
    /// Lifecycle and exit events are IGNORED — those are
    /// handled by the keepalive CM's global
    /// [`OutputRouter::spawn_dispatcher`] task. Per-pane
    /// eviction comes from the global reconcile path; per-tile
    /// dispatchers do not touch router state on shutdown.
    ///
    /// The task exits when `notifs` closes (tile CM died via
    /// `Tmux::shutdown` or because the tile session was
    /// killed). Caller should hold the returned `JoinHandle`
    /// and abort it on connection cleanup so the task exits
    /// deterministically.
    pub fn spawn_output_pump(
        &self,
        mut notifs: mpsc::UnboundedReceiver<Notification>,
    ) -> JoinHandle<()> {
        let router = self.clone();
        tokio::spawn(async move {
            while let Some(notif) = notifs.recv().await {
                if let Notification::Output { pane_id, data } = notif {
                    router.dispatch(pane_id, &data);
                }
                // Other notifications (lifecycle, exit, output
                // for other panes which can't happen since the
                // tile's session has one pane) are intentionally
                // discarded. The keepalive CM's dispatcher
                // handles cross-session lifecycle reconcile.
            }
        })
    }

    pub fn spawn_dispatcher(
        &self,
        mut notifs: mpsc::UnboundedReceiver<Notification>,
        sessions: crate::session::SessionManager,
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
                    Notification::WindowClose { .. }
                    | Notification::UnlinkedWindowClose { .. }
                    | Notification::SessionsChanged => {
                        // Any of these can signal that a pane the
                        // router is tracking has gone away. We
                        // don't trust the specific event — some
                        // versions of tmux prefer one code path
                        // over another depending on whether the
                        // CM client was attached to the dying
                        // session. SessionsChanged fires on every
                        // session add/remove and is the most
                        // reliable "something changed, re-check"
                        // signal; window-close variants are
                        // kept for faster reaction on the hot
                        // path. Reconcile is idempotent, so a
                        // cascade of events (close → sessions-
                        // changed) just does the same work twice.
                        //
                        // Known debt: each event fires its own
                        // `tokio::spawn`. Under a pathological
                        // event storm (e.g., a user-run script
                        // opening + closing many sessions in a
                        // tight loop), this produces one spawn
                        // per event with no coalescing. Future
                        // fix: a single-buffer `tokio::sync::Notify`
                        // drained by a dedicated worker task.
                        // Acceptable for single-user scale since
                        // each task is a lightweight tmux round-
                        // trip and idempotent under concurrency.
                        //
                        // Logging: `reconcile_router` owns the
                        // success info! (it has access to the
                        // `live_panes` count). We only log failures
                        // here — the failure message names this
                        // notification arm as context.
                        let sessions = sessions.clone();
                        let router = router.clone();
                        tokio::spawn(async move {
                            if let Err(e) = sessions.reconcile_router(&router).await {
                                tracing::warn!(
                                    error = %e,
                                    "reconcile_router failed; next event will retry"
                                );
                            }
                        });
                    }
                    other => {
                        tracing::trace!(?other, "tmux notification (no consumer yet)");
                    }
                }
            }
            // Dispatcher ending — propagate the shutdown signal
            // to every attached handler by evicting every pane.
            router.evict_all();
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
    use crate::session::{SessionManager, Tmux};

    /// A `SessionManager` backed by a dead Tmux channel. Calls
    /// to `reconcile_router` will fail with `TmuxError::Disconnected`
    /// — which is exactly what we want for tests that exercise
    /// the dispatcher's notification loop without pulling in a
    /// real tmux subprocess. The dispatcher's fire-and-forget
    /// reconcile path logs the error and moves on, so these
    /// tests still observe the loop's behavior correctly.
    fn dead_sessions() -> SessionManager {
        SessionManager::new(Tmux::dead_for_tests())
    }

    // ---------- Single-subscriber core behaviour ----------

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

    // ---------- Multi-device fan-out ----------

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
            SubscribeError::RouterAtCapacity { .. } => {
                panic!("per-pane cap should hit before router-namespace cap in this test")
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
        let handle = r.spawn_dispatcher(notifs, dead_sessions());

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
        let handle = r.spawn_dispatcher(notifs, dead_sessions());
        drop(tx);
        handle.await.expect("dispatcher exits on sender drop");
    }

    // ---------- Dispatcher-exit shutdown propagation ----------

    #[tokio::test]
    async fn evict_all_closes_every_subscriber_receiver() {
        // Core claim: after evict_all, every attached handler's
        // receiver sees its channel close on the next recv.
        // This is the fix for the "tmux exits, handlers hang"
        // bug — without evict_all, dispatcher dropping its
        // clone leaves per-pane senders alive in the shared
        // Arc<Mutex<HashMap>>.
        let r = OutputRouter::new();
        let (mut a, _ida, _) = r.subscribe(0).unwrap();
        let (mut b, _idb, _) = r.subscribe(1).unwrap();
        let (mut c, _idc, _) = r.subscribe(0).unwrap();

        r.evict_all();
        assert!(a.recv().await.is_none(), "a closed");
        assert!(b.recv().await.is_none(), "b closed");
        assert!(c.recv().await.is_none(), "c on shared pane closed");
        assert_eq!(r.registered_count(), 0);
    }

    #[tokio::test]
    async fn dispatcher_on_notifs_close_triggers_evict_all() {
        // End-to-end: subscribe → start dispatcher → tmux exit
        // → subscriber sees None. Proves the wiring between
        // spawn_dispatcher's shutdown path and evict_all.
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(0).unwrap();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs, dead_sessions());
        tx.send(Notification::Exit {
            reason: Some("tmux died".into()),
        })
        .unwrap();
        handle.await.unwrap();
        assert!(
            rx.recv().await.is_none(),
            "subscriber's recv must yield None after dispatcher-driven evict_all"
        );
    }

    // ---------- Pane eviction / reconcile ----------

    #[tokio::test]
    async fn retain_panes_evicts_panes_not_in_keep_set() {
        // Core claim: panes absent from `keep` are evicted
        // (subscribers' recv yields None), panes present stay
        // live. This is the mechanism SessionManager uses on
        // %window-close to prune zombie panes against tmux's
        // current set of live panes.
        let r = OutputRouter::new();
        let (mut live, _id_l, _) = r.subscribe(1).unwrap();
        let (mut zombie, _id_z, _) = r.subscribe(2).unwrap();
        let keep: HashSet<u32> = [1].into_iter().collect();

        let evicted = r.retain_panes(&keep);
        assert_eq!(evicted, 1);
        assert_eq!(r.registered_count(), 1);
        assert!(zombie.recv().await.is_none(), "zombie pane closed");
        // Live pane still receives.
        r.dispatch(1, "alive");
        let got = live.recv().await.expect("live pane still flows");
        assert_eq!(got.data, b"alive");
    }

    #[tokio::test]
    async fn retain_panes_with_empty_keep_set_evicts_everything() {
        // Equivalent to evict_all but takes the explicit-set
        // path. Verifies that an edge-case reconcile against a
        // tmux reporting zero panes does the right thing.
        let r = OutputRouter::new();
        let (mut a, _id_a, _) = r.subscribe(1).unwrap();
        let (mut b, _id_b, _) = r.subscribe(2).unwrap();

        let evicted = r.retain_panes(&HashSet::new());
        assert_eq!(evicted, 2);
        assert!(a.recv().await.is_none());
        assert!(b.recv().await.is_none());
        assert_eq!(r.registered_count(), 0);
    }

    #[tokio::test]
    async fn retain_panes_keeps_all_when_superset() {
        // A `keep` set larger than what's registered must not
        // evict anything. Covers the common case where tmux
        // reports more live panes than the router is tracking
        // (other sessions nobody's attached to).
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(5).unwrap();
        let keep: HashSet<u32> = [1, 2, 5, 7, 99].into_iter().collect();

        let evicted = r.retain_panes(&keep);
        assert_eq!(evicted, 0);
        assert_eq!(r.registered_count(), 1);
        r.dispatch(5, "still-here");
        assert_eq!(rx.recv().await.unwrap().data, b"still-here");
    }

    #[tokio::test]
    async fn retain_panes_on_empty_router_is_noop() {
        let r = OutputRouter::new();
        let keep: HashSet<u32> = [1, 2, 3].into_iter().collect();
        assert_eq!(r.retain_panes(&keep), 0);
        assert_eq!(r.registered_count(), 0);
    }

    #[tokio::test]
    async fn retain_panes_closes_all_subscribers_on_evicted_pane() {
        // Fan-out interaction: when a pane has multiple
        // subscribers (phone + laptop attached to the same
        // session), eviction must close ALL of them. Otherwise
        // one device would silently freeze while the other
        // continues — worse UX than a clean disconnect.
        let r = OutputRouter::new();
        let (mut phone, _ip, _) = r.subscribe(7).unwrap();
        let (mut laptop, _il, _) = r.subscribe(7).unwrap();

        r.retain_panes(&HashSet::new());
        assert!(phone.recv().await.is_none());
        assert!(laptop.recv().await.is_none());
    }

    #[tokio::test]
    async fn dispatcher_handles_window_close_without_wedging() {
        // Slice 9i wiring: the WindowClose arm fires a detached
        // reconcile task. With a dead SessionManager the reconcile
        // fails (logged + dropped), and the dispatcher loop MUST
        // continue processing subsequent Output. Regression guard
        // against accidentally awaiting the reconcile on the hot
        // path, which would make a flaky tmux freeze all output.
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(7).unwrap();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs, dead_sessions());

        tx.send(Notification::WindowClose { window_id: 42 })
            .unwrap();
        tx.send(Notification::Output {
            pane_id: 7,
            data: "alive".into(),
        })
        .unwrap();
        let got = rx.recv().await.expect("output still flows after WindowClose");
        assert_eq!(got.data, b"alive");

        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn dispatcher_handles_sessions_changed_without_wedging() {
        // SessionsChanged is the catch-all reconcile trigger —
        // fires on add AND remove, so it costs a tmux round-trip
        // even when a session was just created. Verify the
        // dispatcher loop survives the spawned reconcile on this
        // arm the same way it does for window-close.
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(11).unwrap();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs, dead_sessions());

        tx.send(Notification::SessionsChanged).unwrap();
        tx.send(Notification::Output {
            pane_id: 11,
            data: "ok".into(),
        })
        .unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, b"ok");

        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn dispatcher_handles_unlinked_window_close_without_wedging() {
        // Same contract for the tmux 3.3+ alternate notification
        // shape. Both arms route to the same reconcile path.
        let r = OutputRouter::new();
        let (mut rx, _id, _) = r.subscribe(3).unwrap();
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs, dead_sessions());

        tx.send(Notification::UnlinkedWindowClose { window_id: 9 })
            .unwrap();
        tx.send(Notification::Output {
            pane_id: 3,
            data: "still-here".into(),
        })
        .unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got.data, b"still-here");

        drop(tx);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn router_rejects_subscribe_at_max_panes() {
        // Defense-in-depth: a fresh pane cannot register once
        // MAX_PANES is reached. Existing panes still accept
        // new subscribers.
        let r = OutputRouter::new();
        // Fill the router with MAX_PANES distinct panes.
        let mut keep = Vec::new();
        for pane_id in 0..(MAX_PANES as u32) {
            let (rx, _id, _) = r.subscribe(pane_id).unwrap();
            keep.push(rx);
        }
        // A new pane_id beyond the cap is rejected.
        let err = r.subscribe(MAX_PANES as u32).unwrap_err();
        assert!(matches!(err, SubscribeError::RouterAtCapacity { .. }));
        // Existing panes still work.
        let (_rx, _id, _) = r
            .subscribe(0)
            .expect("existing panes still accept subscribers past MAX_PANES");
    }

    #[tokio::test]
    async fn dispatch_drops_unseen_panes_at_max_panes() {
        // Parser-bug / phantom-pane injection: dispatch for an
        // unseen pane_id must NOT grow the map past MAX_PANES.
        let r = OutputRouter::new();
        let mut keep = Vec::new();
        for pane_id in 0..(MAX_PANES as u32) {
            let (rx, _id, _) = r.subscribe(pane_id).unwrap();
            keep.push(rx);
        }
        let before = r.registered_count();
        r.dispatch(MAX_PANES as u32 + 500, "phantom");
        assert_eq!(
            r.registered_count(),
            before,
            "dispatch must not create a new pane past MAX_PANES"
        );
    }

    // ---------- Subscribe-body dedup canary ----------

    #[tokio::test]
    async fn subscribe_fresh_and_resume_share_cap_logic() {
        // Round-1 dedup: both public methods now delegate to
        // do_subscribe and enforce the same pane-namespace cap.
        // This test holds the contract.
        let r = OutputRouter::new();
        let mut keep = Vec::new();
        for pane_id in 0..(MAX_PANES as u32) {
            let (rx, _id, _) = r.subscribe(pane_id).unwrap();
            keep.push(rx);
        }
        // Resume path also rejects a new pane past the cap.
        let err = r
            .subscribe_with_resume(MAX_PANES as u32, 0)
            .unwrap_err();
        assert!(matches!(err, SubscribeError::RouterAtCapacity { .. }));
    }
}
