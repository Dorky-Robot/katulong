//! WebSocket → `TransportHandle` adapter with CBOR wire format.
//!
//! Wraps an axum `WebSocket` in two pump tasks and returns the
//! consumer-facing `TransportHandle`. The terminal handler takes
//! that handle and never sees `axum::extract::ws::*`.
//!
//! # Why CBOR, not JSON
//!
//! katulong is one-user-many-devices and performance-sensitive
//! (the whole WS → WebRTC progressive enhancement exists to save
//! milliseconds). CBOR gives us:
//!
//! - **No base64 overhead** on byte payloads (image paste, raw
//!   terminal input/output). JSON forces string encoding for any
//!   binary field; CBOR's byte-string type carries bytes directly.
//! - **Smaller wire** — typically 30-50% of JSON size for mixed
//!   structured + byte data.
//! - **Uniform wire across transports**. WS binary frames and
//!   WebRTC DataChannel are both native binary; CBOR is the
//!   single encoding that works on both without per-transport
//!   shims.
//! - **Schema evolution**. Self-describing format + serde means
//!   new fields + new variants migrate the same way they did
//!   under JSON.
//!
//! Lost: human-readable frames in Wireshark. The trade is
//! deliberate — CBOR has well-understood debug tooling
//! (`cbor.me`, `cborcli`) and our operator debugging surface is
//! structured logs anyway, not wire captures.
//!
//! # Wire-level responsibilities
//!
//! Two pump tasks:
//!
//! - `input_pump`: reads `WebSocket::recv()` frames, decodes each
//!   binary frame as a `ClientMessage` via CBOR, forwards to the
//!   inbound channel. Rejects text frames (wrong encoding) and
//!   binary frames above the size cap. Reports decode/frame
//!   errors via `Result<ClientMessage, TransportError>` so the
//!   consumer can decide whether to close. Exits on peer Close
//!   or disconnect.
//! - `output_pump`: drains the outbound channel, serializes each
//!   `ServerMessage` to CBOR, sends as binary frame. Exits when
//!   the channel closes (consumer dropped the handle).
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

/// Hard size cap on an individual inbound binary frame, applied
/// BEFORE CBOR decode. Without this, an authenticated attacker
/// could push multi-megabyte frames through a connection that's
/// already past the auth gate; the axum `DefaultBodyLimit` layer
/// covers HTTP bodies, not WS frames once upgrade has completed.
/// 64 KiB is well above any current message and still comfortably
/// above the terminal messages envisioned for slice 9e/9f
/// (keystroke input, resize, session-id strings, small output
/// chunks after coalescing). Large paste payloads that exceed
/// this get fragmented at the client; the CBOR-native byte-string
/// type keeps that overhead minimal without needing base64.
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
            Ok(Message::Binary(bytes)) => {
                if bytes.len() > MAX_INBOUND_FRAME_BYTES {
                    Err(TransportError::DecodeFailed(format!(
                        "frame too large: {} bytes exceeds {} byte limit",
                        bytes.len(),
                        MAX_INBOUND_FRAME_BYTES
                    )))
                } else {
                    ciborium::de::from_reader::<ClientMessage, _>(&bytes[..])
                        .map_err(|e| TransportError::DecodeFailed(e.to_string()))
                }
            }
            // Text frames are rejected: CBOR is the sole wire format.
            // A client sending text is either wrong-version or
            // probing; reject cleanly and let the consumer decide.
            // This rejection is permanent — if a future debug
            // surface wants human-readable wire traffic, it lives
            // as a separate HTTP route (e.g. `/api/debug/ws-trace`),
            // not as a mode flag on the session transport.
            Ok(Message::Text(_)) => Err(TransportError::UnexpectedText),
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
        let mut buf = Vec::new();
        if let Err(e) = ciborium::ser::into_writer(&msg, &mut buf) {
            // `ServerMessage` is a closed set of serde-derived
            // types; CBOR encoding can't fail on any of them today.
            // If it ever does, that's a bug in the type definition
            // — log and skip rather than poisoning the transport
            // for every subsequent message.
            tracing::error!(error = %e, "ServerMessage CBOR encoding failed; dropping frame");
            continue;
        }
        if ws_tx.send(Message::Binary(buf)).await.is_err() {
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
        // largest `ClientMessage` today. Ping serializes to ~10
        // bytes in CBOR; 64 KiB is 6000x that. If slice 9e/9f adds
        // a variant that could legitimately approach this limit,
        // this test is the signal to document an explicit limit
        // on THAT variant rather than just bumping the global cap.
        let ping = ClientMessage::Ping { nonce: u64::MAX };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&ping, &mut buf).unwrap();
        assert!(
            buf.len() < MAX_INBOUND_FRAME_BYTES / 100,
            "max frame bytes must leave 100x headroom over current \
             messages; Ping encoded to {} bytes vs cap {}",
            buf.len(),
            MAX_INBOUND_FRAME_BYTES
        );
    }

    #[test]
    fn cbor_is_smaller_than_json_for_ping() {
        // Not a correctness check; a sanity check that the wire
        // benefit we're trading JSON readability for actually
        // shows up. If this ever fails, CBOR encoding changed
        // behavior and the trade needs re-examination.
        //
        // NOTE: CBOR integer encoding scales with the magnitude
        // of the value (a 1-byte header + up to 8 payload bytes
        // for u64::MAX). JSON encodes integers as ASCII digits
        // (20 chars for u64::MAX). At `nonce: 42` CBOR is
        // unambiguously smaller; for very large nonces CBOR's
        // 9-byte integer vs JSON's 20-char digit string still
        // favors CBOR, but the margin shrinks. Keep the test
        // value small so the assertion stays a clean statement
        // about the encoding's typical shape, not a claim about
        // every u64 value.
        let ping = ClientMessage::Ping { nonce: 42 };
        let mut cbor = Vec::new();
        ciborium::ser::into_writer(&ping, &mut cbor).unwrap();
        let json = serde_json::to_string(&ping).unwrap();
        assert!(
            cbor.len() < json.len(),
            "CBOR ({} bytes) should be smaller than JSON ({} bytes) for Ping",
            cbor.len(),
            json.len()
        );
    }

    #[test]
    fn cbor_roundtrip_preserves_message() {
        let original = ClientMessage::Ping { nonce: 12345 };
        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).unwrap();
        let back: ClientMessage = ciborium::de::from_reader(&buf[..]).unwrap();
        assert_eq!(back, original);
    }
}
