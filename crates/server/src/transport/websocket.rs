//! WebSocket → `TransportHandle` adapter with JSON wire format.
//!
//! Wraps an axum `WebSocket` in two pump tasks and returns the
//! consumer-facing `TransportHandle`. The terminal handler takes
//! that handle and never sees `axum::extract::ws::*`.
//!
//! # Why JSON, not CBOR
//!
//! The Node-cutover plan (phase 0b — this rewrite) moves the live
//! frontend from the partly-built Rust+WASM bundle back to the
//! existing Node SPA in `public/`. That SPA has spoken JSON over
//! text WS frames since day one (`public/lib/ws-message-handlers.js`
//! reads with `JSON.parse(event.data)` and writes with
//! `JSON.stringify`). Asking the SPA to learn CBOR would spread
//! cutover risk across both server and client; cheaper to make the
//! Rust server speak JSON and revisit a binary wire later if
//! profiling shows it actually matters.
//!
//! Lost: the `serde_bytes`-backed CBOR byte-string encoding that
//! kept large pastes off the array-of-int overhead. The SPA's
//! input-cap is 8 KiB (`lib/websocket-validation.js`), and the
//! server-side outbound coalescer keeps `output` chunks small;
//! today's traffic fits comfortably under the 64 KiB frame cap
//! even with JSON's overhead.
//!
//! # Wire-level responsibilities
//!
//! Two pump tasks:
//!
//! - `input_pump`: reads `WebSocket::recv()` frames, decodes each
//!   text frame as a `ClientMessage` via `serde_json::from_str`,
//!   forwards to the inbound channel. Rejects binary frames
//!   (wrong encoding for the Node SPA) and text frames above the
//!   size cap. Reports decode/frame errors via
//!   `Result<ClientMessage, TransportError>` so the consumer can
//!   decide whether to close. Exits on peer Close or disconnect.
//! - `output_pump`: drains the outbound channel, serializes each
//!   `ServerMessage` to JSON, sends as text frame. Exits when the
//!   channel closes (consumer dropped the handle).
//!
//! Protocol keep-alive (WS-level `Ping`/`Pong` frames, distinct
//! from the app-level `ClientMessage::Ping`/`ServerMessage::Pong`)
//! is handled automatically: WS Ping frames receive a WS Pong
//! without surfacing to the consumer. App-level ping/pong is a
//! feature of the ClientMessage/ServerMessage protocol itself so a
//! future non-WS transport (WebRTC) uses the same shape.

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
/// BEFORE JSON decode. Without this, an authenticated attacker
/// could push multi-megabyte frames through a connection that's
/// already past the auth gate; the axum `DefaultBodyLimit` layer
/// covers HTTP bodies, not WS frames once upgrade has completed.
/// 64 KiB sits well above any current message — Node's
/// `validateMessage` caps `input.data` at 8192 chars, and our
/// outbound coalescer keeps `output.data` chunks small. A real
/// paste larger than the inner cap is chunked client-side.
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
                    serde_json::from_str::<ClientMessage>(&text)
                        .map_err(|e| TransportError::DecodeFailed(e.to_string()))
                }
            }
            // Binary frames are rejected: JSON over text is the
            // sole wire format. A client sending binary is either
            // a stale WASM build (the Rust frontend's WS code is
            // frozen during cutover) or a probe; reject cleanly
            // and let the consumer decide what to do.
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
        let json = match serde_json::to_string(&msg) {
            Ok(s) => s,
            Err(e) => {
                // `ServerMessage` is a closed set of serde-derived
                // types; JSON encoding can't fail on any of them
                // today (no `Map` keys with non-string types, no
                // `f32`/`f64` NaN). If it ever does, that's a bug
                // in the type definition — log and skip rather
                // than poisoning the transport for every
                // subsequent message.
                tracing::error!(error = %e, "ServerMessage JSON encoding failed; dropping frame");
                continue;
            }
        };
        if ws_tx.send(Message::Text(json)).await.is_err() {
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
        // largest `ClientMessage` today. Ping serializes to ~16
        // bytes in JSON; 64 KiB is 4000x that. If a future variant
        // approaches this limit, this test is the signal to
        // document an explicit limit on THAT variant rather than
        // just bumping the global cap.
        let ping = ClientMessage::Ping;
        let json = serde_json::to_string(&ping).unwrap();
        assert!(
            json.len() < MAX_INBOUND_FRAME_BYTES / 100,
            "max frame bytes must leave 100x headroom over current \
             messages; Ping encoded to {} bytes vs cap {}",
            json.len(),
            MAX_INBOUND_FRAME_BYTES
        );
    }

    #[test]
    fn json_roundtrip_preserves_message() {
        let original = ClientMessage::Resize {
            cols: 80,
            rows: 24,
            session: None,
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: ClientMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn output_message_serializes_with_camelcase_from_seq() {
        // Wire-shape canary: the Node SPA reads `msg.fromSeq`, not
        // `msg.from_seq`. If a future serde refactor flips the
        // rename annotation off, this test fires before the
        // operator finds out via a broken terminal.
        let msg = ServerMessage::Output {
            session: "main".into(),
            data: "hello".into(),
            from_seq: 0,
            cursor: 5,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(
            json.contains(r#""fromSeq":0"#),
            "outbound JSON must use camelCase fromSeq; got {json}"
        );
    }
}
