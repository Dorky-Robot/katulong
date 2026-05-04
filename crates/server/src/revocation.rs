//! Credential-revocation broadcast channel.
//!
//! When a credential is removed (directly via `/api/credentials/:id`
//! or transitively via `/api/tokens/:id` cascading to its
//! paired device), every long-lived connection bound to that
//! credential must tear down immediately. Without that, a
//! WebSocket — or a future WebRTC peer-link — continues streaming
//! terminal I/O against a credential the operator has already pulled
//! (Node scar `c073ec7`).
//!
//! This module owns the primitive: a `tokio::sync::broadcast` channel
//! emitting `RevocationEvent` values. The design is deliberately
//! transport-agnostic — WS, WebRTC, and any future long-lived
//! bidirectional transport subscribe the same way via
//! `AppState::subscribe_revocations()`. The auth/revoke handlers
//! never know which transports (if any) are listening; they just
//! `.emit(credential_id)` and move on.
//!
//! Broadcast semantics:
//! - Each subscriber gets an independent queue. A slow subscriber
//!   can't backpressure the emitter.
//! - The channel has a bounded capacity; if a subscriber's queue
//!   fills, they receive `Lagged` the next time they poll. For
//!   revocation events this is fine — the receiver can respond to
//!   `Lagged` by assuming the worst and closing its connection,
//!   which is strictly more conservative than what a fresh event
//!   would have triggered. Losing a revocation event is never safe;
//!   losing knowledge of which specific events you missed and
//!   responding defensively is.
//! - Subscribing after an event has fired doesn't see it. Handlers
//!   must subscribe BEFORE they touch anything they'd want to tear
//!   down on revoke (e.g., a WS handler subscribes at upgrade time,
//!   then enters its message loop).
//!
//! # Subscriber contract (read before slice 9c wires WS consumption)
//!
//! 1. **Subscribe before you validate.** A WS handler that accepts
//!    the upgrade, reads the session cookie, validates it against
//!    `AuthStore`, THEN subscribes will miss any revocation that
//!    landed between the validate and the subscribe. Correct order:
//!    subscribe first, then snapshot+validate. The snapshot IS the
//!    "still valid?" check; the subscribe is the "will stay valid?"
//!    guarantee for the lifetime of the connection.
//!
//! 2. **On `Lagged`, close.** Don't try to catch up — the
//!    conservative failure is to assume your credential was among
//!    the lost events. A fresh connection is cheap.
//!
//! 3. **Credential-id equality is the only check.** Subscribers
//!    compare `event.credential_id` to the credential their
//!    connection is bound to. No wildcards, no tree matches.
//!
//! # Emitter contract
//!
//! Any code path that removes a `Credential` from the store must
//! emit on this channel after the transact commits. Today that's
//! enforced socially in two call sites (`revoke_device`,
//! `revoke_token`'s cascade). Future `AuthState` transitions that
//! call `remove_credential` MUST also emit — this obligation has no
//! type-system enforcement. If a background task (e.g., an
//! eventual "expired unused tokens" pruner that cascades to
//! credentials) ever adds a third removal path, wire it through
//! `AppState::revocations.emit(cred_id)` or the WS layer will keep
//! a ghost shell connection against a credential nobody can see
//! anymore.

use tokio::sync::broadcast::{self, error::SendError, Receiver, Sender};

/// Capacity of the revocation broadcast buffer. A subscriber that
/// falls more than this many events behind gets `Lagged` on its
/// next `recv`. 64 is comfortably above what a single-user
/// installation could produce in any realistic interval — the
/// operator would have to be revoking credentials in a tight loop.
const REVOCATION_CHANNEL_CAPACITY: usize = 64;

/// Event published when a credential is revoked. Carries only the
/// credential id, because that's all any subscriber needs — they
/// compare against the credential their connection is bound to and
/// tear down on match.
#[derive(Debug, Clone)]
pub struct RevocationEvent {
    pub credential_id: String,
}

/// Sender half of the broadcast channel, held by `AppState`. Cheap
/// to clone; each clone shares the same broadcast state.
#[derive(Clone)]
pub struct RevocationPublisher {
    sender: Sender<RevocationEvent>,
}

impl RevocationPublisher {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(REVOCATION_CHANNEL_CAPACITY);
        Self { sender }
    }

    /// Publish a revocation. The `Result` conveys whether any
    /// subscribers received it, which callers are free to ignore:
    /// with zero subscribers the channel drops the event, and
    /// that's correct — nothing is currently holding a connection
    /// against that credential.
    pub fn emit(&self, credential_id: impl Into<String>) {
        let event = RevocationEvent {
            credential_id: credential_id.into(),
        };
        let credential_id = event.credential_id.clone();
        match self.sender.send(event) {
            Ok(receiver_count) => {
                tracing::debug!(
                    credential_id = %credential_id,
                    subscribers = receiver_count,
                    "revocation broadcast emitted"
                );
            }
            Err(SendError(_)) => {
                // No active subscribers. Fine — the event had no
                // one to signal. Log at trace so it's observable
                // during debugging without cluttering normal output.
                tracing::trace!(
                    credential_id = %credential_id,
                    "revocation broadcast: no subscribers"
                );
            }
        }
    }

    /// Get a fresh subscriber queue. Handlers subscribe BEFORE they
    /// start whatever long-lived work needs torn down on revoke.
    /// Events emitted before the subscribe call are not delivered
    /// — intentional; a subscriber that just connected can't be
    /// bound to a credential revoked before it arrived.
    pub fn subscribe(&self) -> Receiver<RevocationEvent> {
        self.sender.subscribe()
    }
}

impl Default for RevocationPublisher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn emit_reaches_every_subscriber() {
        let pub_ = RevocationPublisher::new();
        let mut a = pub_.subscribe();
        let mut b = pub_.subscribe();
        pub_.emit("cred-1");

        let got_a = a.recv().await.expect("subscriber a received");
        assert_eq!(got_a.credential_id, "cred-1");
        let got_b = b.recv().await.expect("subscriber b received");
        assert_eq!(got_b.credential_id, "cred-1");
    }

    #[tokio::test]
    async fn emit_with_no_subscribers_is_noop() {
        let pub_ = RevocationPublisher::new();
        // Should not panic, should not hang.
        pub_.emit("cred-1");
    }

    #[tokio::test]
    async fn late_subscriber_misses_earlier_events() {
        let pub_ = RevocationPublisher::new();
        pub_.emit("cred-earlier");
        // Subscribe AFTER the event fires. tokio::broadcast drops
        // events with no subscribers at emit time — intentional,
        // and documented.
        let mut late = pub_.subscribe();

        pub_.emit("cred-later");
        let got = late.recv().await.expect("late subscriber gets only post-subscribe events");
        assert_eq!(
            got.credential_id, "cred-later",
            "late subscriber must not see 'cred-earlier' — it connected after that revocation"
        );
    }

    #[tokio::test]
    async fn publisher_clone_shares_channel() {
        let pub_a = RevocationPublisher::new();
        let pub_b = pub_a.clone();
        let mut rx = pub_a.subscribe();
        pub_b.emit("cred-1");
        let got = rx.recv().await.unwrap();
        assert_eq!(got.credential_id, "cred-1");
    }
}
