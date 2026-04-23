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
//! dispatcher task spawned in `main.rs` holds one clone and
//! calls [`OutputRouter::dispatch`]. Each WS connection handler
//! holds another clone via `AppState` and calls
//! [`OutputRouter::subscribe`] after its `Attach` succeeds.
//!
//! # Single-subscriber invariant (slice 9f)
//!
//! At most one subscriber per `pane_id`. A second concurrent
//! [`OutputRouter::subscribe`] for the same pane returns
//! [`RouterError::AlreadyAttached`]. Slice 9h (multi-device
//! output fan-out) replaces the inner map with per-pane
//! fan-out primitives + a ring buffer for catching up, which is
//! why the decoder's carry state already lives here (see
//! `output.rs`) — it's shared across all subscribers for the
//! pane.
//!
//! # Decoder ownership
//!
//! Each registered pane carries an [`OctalDecoder`]. The
//! dispatcher task decodes bytes BEFORE fanning out to the
//! subscriber, not after: when multi-device lands, every
//! subscriber gets the same fully-decoded byte stream and the
//! octal-carry state lives in exactly one place.
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
//! slice 9h is the proper fix for drops; until then, generous
//! buffer depth + fast consumer keeps drops to pathological
//! cases.

use crate::session::output::OctalDecoder;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Per-pane queue capacity. Tmux emits one `%output` per I/O
/// boundary; a single TUI frame is typically 1–10 chunks, and
/// the handler drains each chunk into a coalescer in constant
/// time. 256 gives a generous headroom above any realistic burst
/// without committing huge memory (each entry is a small `Vec`).
const PER_PANE_BUFFER: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum RouterError {
    /// Another subscriber is already attached to this pane.
    /// Slice 9f enforces single-subscriber-per-pane so the
    /// decoder's carry state has exactly one reader; slice 9h
    /// with multi-device fan-out relaxes this.
    #[error("another connection is already attached to pane %{0}")]
    AlreadyAttached(u32),
}

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

    /// Register interest in `pane_id` and get back the receiver
    /// the dispatcher will push decoded bytes to. Fails if the
    /// pane is already subscribed.
    ///
    /// The returned receiver is bounded at `PER_PANE_BUFFER`.
    /// Drop it to unsubscribe; the dispatcher's `try_send` will
    /// fail silently and the handler's cleanup path calls
    /// [`OutputRouter::unsubscribe`] to remove the decoder too.
    pub fn subscribe(&self, pane_id: u32) -> Result<mpsc::Receiver<Vec<u8>>, RouterError> {
        let mut panes = self.inner.lock().expect("output-router mutex poisoned");
        if panes.contains_key(&pane_id) {
            return Err(RouterError::AlreadyAttached(pane_id));
        }
        let (tx, rx) = mpsc::channel(PER_PANE_BUFFER);
        panes.insert(
            pane_id,
            PaneState {
                sender: tx,
                decoder: OctalDecoder::new(),
            },
        );
        Ok(rx)
    }

    /// Remove a pane's registration. Safe to call when no
    /// subscriber is registered (no-op). Handlers MUST call this
    /// on Drop so the decoder's carry buffer doesn't leak across
    /// reconnects on the same pane.
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
                    // subscribes see a clean slate.
                    panes.remove(&pane_id);
                }
            }
        }
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
        let mut rx = r.subscribe(0).expect("first subscribe succeeds");
        r.dispatch(0, "hello");
        let got = rx.recv().await.expect("bytes arrive");
        assert_eq!(got, b"hello");
    }

    #[tokio::test]
    async fn dispatch_decodes_octal() {
        let r = OutputRouter::new();
        let mut rx = r.subscribe(7).unwrap();
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
        let mut rx = r.subscribe(0).unwrap();
        r.dispatch(0, r"\342\226\2");
        r.dispatch(0, "10");
        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        let mut combined = first;
        combined.extend(second);
        assert_eq!(combined, &[0xE2, 0x96, 0x88]);
    }

    #[tokio::test]
    async fn second_subscribe_to_same_pane_fails() {
        // Single-subscriber invariant for slice 9f — relaxed
        // when 9h lands multi-device.
        let r = OutputRouter::new();
        let _rx1 = r.subscribe(0).unwrap();
        let err = r.subscribe(0).unwrap_err();
        assert!(matches!(err, RouterError::AlreadyAttached(0)));
    }

    #[tokio::test]
    async fn unsubscribe_allows_resubscribe() {
        // Reconnect semantics: a client whose handler exits
        // unsubscribes; a fresh connection can then attach to the
        // same pane.
        let r = OutputRouter::new();
        let _rx1 = r.subscribe(0).unwrap();
        r.unsubscribe(0);
        let _rx2 = r.subscribe(0).expect("resubscribe after unsubscribe");
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
        let rx = r.subscribe(5).unwrap();
        drop(rx);
        r.dispatch(5, "posthumous"); // send fails → prune
        assert_eq!(r.registered_count(), 0);
        // Subscribe now succeeds again.
        let _rx = r.subscribe(5).unwrap();
    }

    #[tokio::test]
    async fn unsubscribe_is_idempotent() {
        let r = OutputRouter::new();
        r.unsubscribe(99); // nothing registered — no-op
        let _rx = r.subscribe(1).unwrap();
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
        let mut rx = r1.subscribe(0).unwrap();
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
        let mut rx = r.subscribe(0).unwrap();
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
}
