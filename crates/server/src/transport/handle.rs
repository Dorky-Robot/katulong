//! The transport abstraction that decouples session I/O from the
//! underlying wire protocol.
//!
//! Every code path that moves messages between server and client
//! takes a `TransportHandle` — never a raw `WebSocket`, never a
//! `DataChannel`, never whatever transport we invent next. The
//! session/terminal handler (slice 9d+) consumes a `TransportHandle`
//! and doesn't know or care what pumps it.
//!
//! See project memory `project_transport_agnostic` for the full
//! rationale. The short version: Node shipped WebRTC twice. The
//! first attempt (`d844862`) scattered `ws.send`/`dc.send` across
//! features and the dual-path sequencing bugs piled up until the
//! whole thing got ripped out. The second attempt (`2c06a8b`)
//! worked because a thin per-client wrapper owned the routing
//! decision. We ship the thin wrapper here on the Rust side
//! before ANY feature module exists that could accidentally cement
//! a wrong pattern.
//!
//! # Invariants
//!
//! 1. Exactly one transport carries data at a time. Switching
//!    transports (e.g., WS upgrading to WebRTC DataChannel) is a
//!    handle swap — the consumer replaces its current
//!    `TransportHandle` with a new one atomically. There is no
//!    moment when both are "half active."
//! 2. The slower/more-reliable transport (WS) stays alive for
//!    signaling and fallback even when a faster one (DC) is
//!    carrying data. That's the WebRTC transport's concern, not
//!    this abstraction's — the abstraction just lets the
//!    terminal handler switch over.
//! 3. Closing the handle closes the underlying transport. Dropping
//!    the handle without explicit close is fine too (pump tasks
//!    observe the channels closing and exit), but `close().await`
//!    is the graceful path that sends a proper close frame.
//! 4. **Drain-before-close on transport swap.** When the consumer
//!    replaces a handle during upgrade, the old handle's `outbound`
//!    sender must NOT be force-closed before the output pump has
//!    drained whatever's buffered (up to 64 messages). The current
//!    implementation achieves this implicitly: dropping the old
//!    `TransportHandle` drops its `outbound` sender, the pump's
//!    `outbound.recv().await` keeps yielding until the channel is
//!    empty, THEN yields `None`. Any future `close().await` method
//!    added here must preserve this — or it will silently drop
//!    terminal output that was in flight at swap time.

use super::message::{ClientMessage, ServerMessage};
use tokio::sync::mpsc;

/// Which wire protocol is currently carrying data. Surfaced to the
/// client as a 3-state connection indicator (disconnected / relay /
/// direct — per Node scar `2c06a8b`). For slice 9c only
/// `WebSocket` exists. The `WebRtc` variant will land in the same
/// slice that ships the WebRTC transport implementation — adding
/// it speculatively here produces compile-time noise at match
/// sites (dead-code lint) without any enforcement benefit, since
/// there are no match-exhaustive sites yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    WebSocket,
}

/// Errors observed on the transport pump tasks. Delivered through
/// the inbound channel when a frame fails to decode or the peer
/// sends an unexpected frame type.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// Peer sent a payload we couldn't decode into a
    /// `ClientMessage`. The transport stays open; the caller
    /// decides whether to close on decode failure.
    #[error("malformed client message: {0}")]
    DecodeFailed(String),
    /// Peer sent a binary frame when we only accept text.
    #[error("binary frames are not accepted")]
    UnexpectedBinary,
    /// Underlying I/O error from the transport. After this, the
    /// inbound channel closes.
    #[error("transport I/O: {0}")]
    Io(String),
}

/// The consumer-facing side of a connection. Carries:
///
/// - `inbound` — client→server messages, each already typed and
///   validated, or a `TransportError` for decode/frame failures.
///   Closing = peer disconnected or pump task exited.
/// - `outbound` — server→client sender. The transport's output
///   pump drains this onto the wire. Dropping it signals the
///   output pump to finish and close the transport.
/// - `kind` — static tag for the active wire. Used for logging
///   and the client's connection-state UI.
///
/// The handle is NOT `Clone`. Exactly one consumer owns it at any
/// point, because "split between two consumers" would race on
/// outbound ordering. Handoffs (e.g., WS→DC upgrade) happen by
/// swapping the handle, not sharing it.
pub struct TransportHandle {
    pub inbound: mpsc::Receiver<Result<ClientMessage, TransportError>>,
    pub outbound: mpsc::Sender<ServerMessage>,
    pub kind: TransportKind,
}

impl TransportHandle {
    /// Send a `ServerMessage` on the outbound channel. Returns
    /// error if the transport has already closed (pump task
    /// exited). Thin wrapper around the sender; callers can reach
    /// `handle.outbound` directly too.
    pub async fn send(&self, msg: ServerMessage) -> Result<(), TransportSendError> {
        self.outbound
            .send(msg)
            .await
            .map_err(|_| TransportSendError::Closed)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportSendError {
    /// The transport closed before the message could be delivered.
    /// Consumers typically exit their event loop on this.
    #[error("transport is closed")]
    Closed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn send_on_closed_transport_errors() {
        let (outbound_tx, outbound_rx) = mpsc::channel(4);
        let (_inbound_tx, inbound_rx) =
            mpsc::channel::<Result<ClientMessage, TransportError>>(4);
        let handle = TransportHandle {
            inbound: inbound_rx,
            outbound: outbound_tx,
            kind: TransportKind::WebSocket,
        };
        // Simulate the pump task exiting: drop the outbound receiver.
        drop(outbound_rx);
        let err = handle
            .send(ServerMessage::Pong { nonce: 1 })
            .await
            .unwrap_err();
        assert!(matches!(err, TransportSendError::Closed));
    }

    #[tokio::test]
    async fn inbound_closes_when_sender_drops() {
        let (outbound_tx, _outbound_rx) = mpsc::channel(4);
        let (inbound_tx, inbound_rx) =
            mpsc::channel::<Result<ClientMessage, TransportError>>(4);
        let mut handle = TransportHandle {
            inbound: inbound_rx,
            outbound: outbound_tx,
            kind: TransportKind::WebSocket,
        };
        drop(inbound_tx); // pump exited
        assert!(handle.inbound.recv().await.is_none());
    }
}
