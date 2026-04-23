//! WebSocket → `TransportHandle` adapter.
//!
//! Wraps an axum `WebSocket` in two pump tasks and returns the
//! consumer-facing `TransportHandle`. The terminal handler (slice
//! 9d) takes that handle and never sees `axum::extract::ws::*`.
//!
//! Dual pumps:
//!
//! - `input_pump`: reads `WebSocket::recv()` frames, decodes JSON
//!   text as `ClientMessage`, forwards to the inbound channel.
//!   Reports decode/frame errors via
//!   `Result<ClientMessage, TransportError>` so the consumer can
//!   decide whether to close. Exits when the peer disconnects or
//!   sends Close.
//! - `output_pump`: drains the outbound channel, serializes each
//!   `ServerMessage` as JSON, sends as text frame. Exits when the
//!   channel closes (consumer dropped the handle).
//!
//! Protocol keep-alive (WS-level `Ping`/`Pong` frames, distinct
//! from the app-level `ClientMessage::Ping`/`ServerMessage::Pong`)
//! is handled automatically: WS Ping frames receive a WS Pong
//! without surfacing to the consumer. App-level ping/pong is a
//! feature of the ClientMessage/ServerMessage protocol itself and
//! lets a future non-WS transport (WebRTC) use the same shape.

use super::handle::{TransportError, TransportHandle, TransportKind};
use super::message::{ClientMessage, ServerMessage};
use axum::extract::ws::{Message, WebSocket};

/// Outbound buffer depth. If the consumer produces messages faster
/// than the WS pump can drain, backpressure kicks in at this
/// many queued messages. 64 is generous for an interactive
/// terminal — at one message per keystroke + output chunk, a
/// sustained backlog indicates the wire is genuinely slow and the
/// consumer should pause rather than accumulate.
const OUTBOUND_BUFFER: usize = 64;

/// Inbound buffer depth. The WS pump pushes each decoded frame
/// here; the consumer drains. 64 is again generous for any real
/// typing rate. A full buffer under non-adversarial load means the
/// consumer is behind and we should drop to let it catch up — the
/// alternative is an unbounded channel growing toward OOM.
const INBOUND_BUFFER: usize = 64;

/// Take ownership of a `WebSocket` and return the transport handle
/// plus two `JoinHandle`s — consumer typically waits on them via
/// a shutdown path or ignores them to let them run in the
/// background until the socket closes naturally.
///
/// The handle is returned already carrying `TransportKind::WebSocket`.
/// Consumers that want to distinguish transports for logging or UI
/// read `handle.kind`.
pub fn into_transport(ws: WebSocket) -> TransportHandle {
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel::<ServerMessage>(OUTBOUND_BUFFER);
    let (inbound_tx, inbound_rx) =
        tokio::sync::mpsc::channel::<Result<ClientMessage, TransportError>>(INBOUND_BUFFER);

    let (ws_tx, ws_rx) = {
        use futures::StreamExt;
        ws.split()
    };

    tokio::spawn(input_pump(ws_rx, inbound_tx));
    tokio::spawn(output_pump(ws_tx, outbound_rx));

    TransportHandle {
        inbound: inbound_rx,
        outbound: outbound_tx,
        kind: TransportKind::WebSocket,
    }
}

async fn input_pump(
    mut ws_rx: futures::stream::SplitStream<WebSocket>,
    inbound: tokio::sync::mpsc::Sender<Result<ClientMessage, TransportError>>,
) {
    use futures::StreamExt;
    while let Some(frame) = ws_rx.next().await {
        let decoded = match frame {
            Ok(Message::Text(text)) => match serde_json::from_str::<ClientMessage>(&text) {
                Ok(m) => Ok(m),
                Err(e) => Err(TransportError::DecodeFailed(e.to_string())),
            },
            Ok(Message::Binary(_)) => Err(TransportError::UnexpectedBinary),
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                // WS-level keepalive. axum auto-responds to Ping;
                // we just drop them from the inbound stream so the
                // consumer only sees app-level messages.
                continue;
            }
            Ok(Message::Close(_)) => break,
            Err(e) => Err(TransportError::Io(e.to_string())),
        };
        // If the consumer has dropped the receiver, there's nothing
        // to do but exit — this is graceful teardown.
        if inbound.send(decoded).await.is_err() {
            break;
        }
    }
    // Drop `inbound` by returning → consumer's `recv().await`
    // yields None → transport is reported closed.
}

async fn output_pump(
    mut ws_tx: futures::stream::SplitSink<WebSocket, Message>,
    mut outbound: tokio::sync::mpsc::Receiver<ServerMessage>,
) {
    use futures::SinkExt;
    while let Some(msg) = outbound.recv().await {
        let Ok(text) = serde_json::to_string(&msg) else {
            // `ServerMessage` is a closed set of types; serde_json
            // can't fail on any of them today. If it ever does,
            // that's a bug in the type definition — log and skip
            // rather than poisoning the transport for every
            // subsequent message.
            tracing::error!("ServerMessage serialization failed; dropping frame");
            continue;
        };
        if ws_tx.send(Message::Text(text)).await.is_err() {
            break;
        }
    }
    let _ = ws_tx.close().await;
}
