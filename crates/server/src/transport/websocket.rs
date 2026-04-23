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
use tokio::task::JoinHandle;

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

/// Hard size cap on an individual inbound text frame, applied
/// BEFORE the frame reaches `serde_json::from_str`. Without this,
/// an authenticated attacker could push multi-megabyte frames
/// through a connection that's already past the auth gate; the
/// axum `DefaultBodyLimit` layer covers HTTP bodies, not WS
/// frames once upgrade has completed. 64 KiB is well above any
/// slice-9c message (`Ping { nonce: u64 }` is ~30 bytes) and
/// still comfortably above the slice-9d terminal messages
/// envisioned so far (input keystroke, resize, session-id
/// strings). A future `InputBytes` variant for terminal paste
/// would need its own limit decision documented alongside the
/// type — this constant stays as the catch-all for everything
/// else.
const MAX_INBOUND_FRAME_BYTES: usize = 64 * 1024;

/// The pump tasks spawned by `into_transport`. Returned alongside
/// the handle so consumers can `await` them for a graceful
/// shutdown (after dropping the handle) — or ignore them and let
/// the tokio runtime abort on shutdown. Not holding onto these is
/// safe: both pumps observe their channels closing when the handle
/// drops and exit on their own.
pub struct TransportPumps {
    pub input: JoinHandle<()>,
    pub output: JoinHandle<()>,
}

/// Take ownership of a `WebSocket`, return the transport handle
/// plus the pump task handles. Most consumers ignore the pumps
/// (drop the `TransportPumps` — the tasks stay alive until the
/// channels close); a future proactive shutdown path (e.g.,
/// session revocation wanting to rip the transport down
/// immediately) can drop the handle and await the pumps for a
/// clean teardown.
///
/// The handle carries `TransportKind::WebSocket`. Consumers that
/// want to log transport kind read `handle.kind`.
pub fn into_transport(ws: WebSocket) -> (TransportHandle, TransportPumps) {
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel::<ServerMessage>(OUTBOUND_BUFFER);
    let (inbound_tx, inbound_rx) =
        tokio::sync::mpsc::channel::<Result<ClientMessage, TransportError>>(INBOUND_BUFFER);

    let (ws_tx, ws_rx) = {
        use futures::StreamExt;
        ws.split()
    };

    let input = tokio::spawn(input_pump(ws_rx, inbound_tx));
    let output = tokio::spawn(output_pump(ws_tx, outbound_rx));

    (
        TransportHandle {
            inbound: inbound_rx,
            outbound: outbound_tx,
            kind: TransportKind::WebSocket,
        },
        TransportPumps { input, output },
    )
}

async fn input_pump(
    mut ws_rx: futures::stream::SplitStream<WebSocket>,
    inbound: tokio::sync::mpsc::Sender<Result<ClientMessage, TransportError>>,
) {
    use futures::StreamExt;
    while let Some(frame) = ws_rx.next().await {
        let decoded = match frame {
            Ok(Message::Text(text)) => {
                if text.len() > MAX_INBOUND_FRAME_BYTES {
                    Err(TransportError::DecodeFailed(format!(
                        "frame too large: {} bytes exceeds {} byte limit",
                        text.len(),
                        MAX_INBOUND_FRAME_BYTES
                    )))
                } else {
                    match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(m) => Ok(m),
                        Err(e) => Err(TransportError::DecodeFailed(e.to_string())),
                    }
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_inbound_frame_bytes_is_generous_vs_current_messages() {
        // Paranoia test: the cap must sit comfortably above the
        // largest `ClientMessage` today. Ping serializes to ~30
        // bytes; 64 KiB is 2000x that. If slice 9d adds a variant
        // that could legitimately approach this limit, this test
        // is the signal to document an explicit limit on THAT
        // variant rather than just bumping the global cap.
        let ping = ClientMessage::Ping { nonce: u64::MAX };
        let s = serde_json::to_string(&ping).unwrap();
        assert!(
            s.len() < MAX_INBOUND_FRAME_BYTES / 100,
            "max frame bytes must leave 100x headroom over current \
             messages; Ping serialized to {} bytes vs cap {}",
            s.len(),
            MAX_INBOUND_FRAME_BYTES
        );
    }
}
