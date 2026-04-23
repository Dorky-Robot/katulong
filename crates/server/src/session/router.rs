//! Dispatcher from the single global tmux `%output` stream to
//! per-connection output pumps.
//!
//! One tmux subprocess produces notifications for every pane on
//! every session it hosts. A per-connection handler only cares
//! about ONE pane (the one its `Attach` bound). The router is
//! the thin indirection that routes a `%output <pane_id> <data>`
//! notification to the right subscriber without forcing every
//! handler to filter the whole stream itself.
//!
//! # Ownership model
//!
//! `OutputRouter` is cheap to clone — internals are `Arc`. The
//! dispatcher task spawned via [`OutputRouter::spawn_dispatcher`]
//! holds one clone and calls [`OutputRouter::dispatch`] for every
//! `%output` notification. Each WS connection handler holds
//! another clone via `AppState` and calls
//! [`OutputRouter::subscribe`] after its `Attach` succeeds.
//!
//! # Attach-displaces-prior semantics (slice 9f)
//!
//! `subscribe(pane_id)` always succeeds. If a prior subscriber
//! already held the pane, their `mpsc::Receiver` sees its
//! channel close on the next `recv()` and the handler's loop
//! treats that as `Action::Exit` (see `handler.rs`). This
//! matches katulong's one-user-many-devices model: opening the
//! app in a second browser tab smoothly takes over the terminal
//! rather than refusing with an error the user has to
//! troubleshoot. Slice 9h revisits this when multi-device
//! fan-out lands — at that point the question "displace vs
//! fan-out" is a product decision rather than a plumbing
//! constraint.
//!
//! # Decoder ownership
//!
//! Each registered pane carries an [`OctalDecoder`]. The
//! dispatcher task decodes bytes BEFORE fanning out to the
//! subscriber, not after: when multi-device lands, every
//! subscriber gets the same fully-decoded byte stream and the
//! octal-carry state lives in exactly one place. The decoder's
//! carry survives the attach-displaces-prior handoff because
//! the decoder is keyed per-pane, not per-subscriber — a
//! reconnecting client picks up mid-escape if the tmux wrap
//! happened to land there.
//!
//! # Backpressure
//!
//! The per-pane mpsc channel has a bounded capacity
//! (`PER_PANE_BUFFER`). If the subscriber's handler falls behind
//! (slow client, coalescer saturated, etc.), `try_send` fails
//! and the dispatcher DROPS the bytes with a `warn!` log rather
//! than backpressuring the whole tmux stream. Output loss is
//! visible to the user as a terminal glitch, but the alternative
//! — blocking the tmux reader task on one slow client —
//! starves every other pane's output. Ring-buffer + resync in
//! slice 9g is the proper fix for drops; until then, generous
//! buffer depth + fast consumer keeps drops to pathological
//! cases.
//!
//! # Stale-entry cleanup (panicked handler)
//!
//! If a handler task panics between `subscribe` and its
//! explicit `unsubscribe` cleanup, the `mpsc::Receiver` drops
//! but the `PaneState` (with its decoder carry) remains in the
//! map. `dispatch`'s `TrySendError::Closed` branch prunes it on
//! the next attempted send. For a quiet pane (no `%output`
//! between the panic and a reconnect attempt), this means the
//! `subscribe` call implicitly overwrites the stale entry —
//! which is now ALWAYS correct under the replace-semantics
//! above (it used to also matter for the old
//! `AlreadyAttached` rejection path, which is gone).

use crate::session::output::OctalDecoder;
use crate::session::parser::Notification;
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

/// Router between the global tmux notification stream and the
/// per-pane subscribers. See the module doc.
#[derive(Clone, Default)]
pub struct OutputRouter {
    inner: Arc<Mutex<HashMap<u32, PaneState>>>,
}

struct PaneState {
    sender: mpsc::Sender<Vec<u8>>,
    decoder: OctalDecoder,
}

impl OutputRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to `pane_id`'s decoded byte stream. Always
    /// succeeds — if a prior subscriber is already registered,
    /// their sender is dropped (their `recv` yields `None` on the
    /// next poll → handler exits via `Action::Exit`) and the new
    /// subscriber takes over. The decoder's carry buffer survives
    /// the swap because it's per-pane, not per-subscriber.
    ///
    /// See the "Attach-displaces-prior" section of the module
    /// doc for the one-user-many-devices rationale.
    pub fn subscribe(&self, pane_id: u32) -> mpsc::Receiver<Vec<u8>> {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        match panes.get_mut(&pane_id) {
            Some(existing) => {
                // Replace the sender. The old sender drops when
                // this assignment lands, which closes the old
                // receiver and lets the old handler exit cleanly.
                // KEEP the decoder: carry state is about the tmux
                // byte stream, not about the subscriber.
                existing.sender = tx;
            }
            None => {
                panes.insert(
                    pane_id,
                    PaneState {
                        sender: tx,
                        decoder: OctalDecoder::new(),
                    },
                );
            }
        }
        rx
    }

    /// Remove a pane's registration. Safe to call when no
    /// subscriber is registered (no-op). Handlers MUST call this
    /// on clean exit so the decoder's carry buffer doesn't leak.
    /// On a panicked handler exit, `dispatch`'s stale-entry
    /// pruning (see the module doc) eventually cleans up.
    pub fn unsubscribe(&self, pane_id: u32) {
        let _ = self
            .inner
            .lock()
            .expect("output-router mutex poisoned")
            .remove(&pane_id);
    }

    /// Route a raw `%output <pane_id> <data>` notification to
    /// its subscriber (if any). Decodes octal escapes, folds in
    /// any carry from the previous dispatch to this pane, and
    /// sends the resulting bytes via the per-pane mpsc.
    ///
    /// The input `raw` is expected to be tmux control-mode-
    /// encoded text (the decoder handles `\\` and `\NNN`
    /// escapes). A future non-tmux transport producing pre-
    /// decoded bytes would bypass the router's dispatch, NOT
    /// feed them in raw — the decoder would passthrough safely
    /// only because it has a fast-path on "no backslash," and
    /// relying on that is fragile. Keep `dispatch` for
    /// tmux-encoded input.
    ///
    /// If no subscriber is registered, the notification is
    /// dropped silently — tmux panes unrelated to any katulong
    /// connection still produce output (e.g., the initial
    /// session hosting a detached shell) and the router isn't
    /// the right place to noise-log them.
    pub fn dispatch(&self, pane_id: u32, raw: &str) {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        let Some(state) = panes.get_mut(&pane_id) else {
            return;
        };
        let decoded = state.decoder.decode(raw);
        if decoded.is_empty() {
            // Entire chunk was absorbed into the carry (a single
            // trailing `\` for example). Nothing to dispatch
            // yet; the next chunk will carry through.
            return;
        }
        if let Err(err) = state.sender.try_send(decoded) {
            match err {
                mpsc::error::TrySendError::Full(_) => {
                    // Subscriber fell behind. Dropping here is a
                    // visible glitch; blocking the dispatcher
                    // would starve every other pane. Logged so
                    // operators see the pressure.
                    tracing::warn!(
                        pane_id,
                        "output dispatch dropped — subscriber queue full"
                    );
                }
                mpsc::error::TrySendError::Closed(_) => {
                    // Subscriber dropped their receiver without
                    // calling unsubscribe (e.g., handler panic).
                    // Remove the entry so future dispatches and
                    // subscribes see a clean slate. A quiet pane
                    // might not trigger this path until the next
                    // `%output` arrives — a subscribe() call
                    // before that would overwrite the stale
                    // entry anyway (see `subscribe`).
                    panes.remove(&pane_id);
                }
            }
        }
    }

    /// Spawn the dispatcher task: a loop that drains `notifs`
    /// (the `mpsc::UnboundedReceiver<Notification>` handed back
    /// by `Tmux::spawn`) and routes each `%output` event through
    /// `dispatch`. Returns the task's `JoinHandle` so the
    /// caller can await shutdown; in practice `main.rs` lets
    /// the runtime abort it on process exit.
    ///
    /// # Non-blocking invariant
    ///
    /// `Tmux::spawn` returns an UNBOUNDED receiver; if this
    /// task ever blocks in `dispatch`, tmux notifications
    /// accumulate toward OOM. `dispatch` is `try_send`-based
    /// (drops on full subscriber rather than awaiting), so the
    /// only way to block this task is synchronous contention
    /// on the router's internal mutex. That critical section
    /// is short (decoder step + try_send) even under slice 9h's
    /// multi-subscriber fan-out — revisit if a profile ever
    /// shows the dispatcher as the bottleneck.
    ///
    /// # Lifecycle
    ///
    /// The task exits when:
    /// - `notifs` is closed (the `Tmux` client drops or
    ///   shutdown completes), OR
    /// - a `Notification::Exit` event fires (tmux's control
    ///   connection tore down).
    ///
    /// On exit it logs and the task terminates; the router
    /// continues to exist for any handlers that hold clones,
    /// but nothing feeds it.
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
                        // Other notifications aren't consumed
                        // yet. Logged at trace so operators can
                        // enable them selectively when diagnosing.
                        tracing::trace!(?other, "tmux notification (no consumer yet)");
                    }
                }
            }
        })
    }

    /// Number of currently-registered panes. Test-only; not
    /// exposed in release builds so callers can't build load-
    /// bearing logic on it (the map's contents are a dispatch
    /// implementation detail).
    #[cfg(test)]
    pub fn registered_count(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn subscribe_then_dispatch_delivers_bytes() {
        let r = OutputRouter::new();
        let mut rx = r.subscribe(0);
        r.dispatch(0, "hello");
        let got = rx.recv().await.expect("bytes arrive");
        assert_eq!(got, b"hello");
    }

    #[tokio::test]
    async fn dispatch_decodes_octal() {
        let r = OutputRouter::new();
        let mut rx = r.subscribe(7);
        r.dispatch(7, r"\033[2J");
        let got = rx.recv().await.unwrap();
        assert_eq!(got, &[0x1B, b'[', b'2', b'J']);
    }

    #[tokio::test]
    async fn dispatch_carries_partial_escape_across_calls() {
        // The multi-device rationale lives or dies on the
        // decoder state being held by the router, not by the
        // subscriber. Split a `\342\226\210` mid-escape and
        // confirm the second dispatch reassembles correctly.
        let r = OutputRouter::new();
        let mut rx = r.subscribe(0);
        r.dispatch(0, r"\342\226\2");
        r.dispatch(0, "10");
        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        let mut combined = first;
        combined.extend(second);
        assert_eq!(combined, &[0xE2, 0x96, 0x88]);
    }

    #[tokio::test]
    async fn second_subscribe_displaces_prior_and_closes_its_channel() {
        // One-user-many-devices: a second attach should smoothly
        // take over the pane, not error. The prior subscriber's
        // receiver sees its channel close on next recv.
        let r = OutputRouter::new();
        let mut first = r.subscribe(0);
        let mut second = r.subscribe(0);
        r.dispatch(0, "routed");

        // Old subscriber: next recv yields None (closed).
        assert!(
            first.recv().await.is_none(),
            "prior subscription must close when replaced"
        );
        // New subscriber: gets the bytes.
        let got = second.recv().await.expect("new subscriber gets bytes");
        assert_eq!(got, b"routed");
    }

    #[tokio::test]
    async fn displaced_keeps_decoder_carry() {
        // The decoder is per-pane, not per-subscriber. When we
        // replace the subscriber mid-escape, the partial escape
        // must still resolve cleanly on the new subscriber's
        // bytes.
        let r = OutputRouter::new();
        let _old = r.subscribe(0);
        r.dispatch(0, r"\342\226\2"); // carries one byte
        let mut new_sub = r.subscribe(0);
        r.dispatch(0, "10"); // completes the escape
        // The "\342\226" part went to the old sub (now closed),
        // dropped silently. The new sub sees only the completion.
        let got = new_sub.recv().await.unwrap();
        assert_eq!(got, &[0x88]);
    }

    #[tokio::test]
    async fn unsubscribe_allows_resubscribe() {
        let r = OutputRouter::new();
        let _rx1 = r.subscribe(0);
        r.unsubscribe(0);
        let _rx2 = r.subscribe(0);
        assert_eq!(r.registered_count(), 1);
    }

    #[tokio::test]
    async fn dispatch_with_no_subscriber_is_silent() {
        // The initial tmux session hosts output unrelated to any
        // connection — those panes must not log-spam the router.
        let r = OutputRouter::new();
        r.dispatch(42, "orphaned output");
        assert_eq!(r.registered_count(), 0);
    }

    #[tokio::test]
    async fn dispatch_prunes_closed_subscriber() {
        let r = OutputRouter::new();
        let rx = r.subscribe(5);
        drop(rx);
        r.dispatch(5, "posthumous"); // send fails → prune
        assert_eq!(r.registered_count(), 0);
        // Subscribe now succeeds again (with a fresh decoder).
        let _rx = r.subscribe(5);
    }

    #[tokio::test]
    async fn unsubscribe_is_idempotent() {
        let r = OutputRouter::new();
        r.unsubscribe(99); // nothing registered — no-op
        let _rx = r.subscribe(1);
        r.unsubscribe(1);
        r.unsubscribe(1); // already gone — no-op
    }

    #[tokio::test]
    async fn router_clones_share_state() {
        // Dispatcher task and handler task each hold a clone of
        // the same `OutputRouter`. Operations on one must be
        // visible on the other.
        let r1 = OutputRouter::new();
        let r2 = r1.clone();
        let mut rx = r1.subscribe(0);
        r2.dispatch(0, "cross");
        let got = rx.recv().await.unwrap();
        assert_eq!(got, b"cross");
    }

    #[tokio::test]
    async fn carry_only_output_does_not_dispatch_empty() {
        // A chunk that is entirely absorbed into the carry
        // (single `\`) must NOT send an empty Vec to the
        // subscriber — we'd be telling the client "here's output"
        // when really we're still waiting for the tail. Silence
        // is the correct signal.
        let r = OutputRouter::new();
        let mut rx = r.subscribe(0);
        r.dispatch(0, r"\");
        // Nothing should be receivable yet.
        let got = rx.try_recv();
        assert!(
            got.is_err(),
            "dispatch that absorbed entirely into carry must send nothing; got {got:?}"
        );
        // Completing the escape delivers bytes.
        r.dispatch(0, "033");
        let bytes = rx.recv().await.unwrap();
        assert_eq!(bytes, &[0x1B]);
    }

    #[tokio::test]
    async fn spawn_dispatcher_routes_output_and_exits_on_tmux_exit() {
        let r = OutputRouter::new();
        let mut rx = r.subscribe(3);
        let (tx, notifs) = mpsc::unbounded_channel::<Notification>();
        let handle = r.spawn_dispatcher(notifs);

        tx.send(Notification::Output {
            pane_id: 3,
            data: "ping".into(),
        })
        .unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got, b"ping");

        // Non-routed notifications are logged but not forwarded.
        tx.send(Notification::WindowClose { window_id: 0 }).unwrap();

        // Exit notification terminates the dispatcher task.
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
