//! WebSocket platform primitive — opens the session-protocol
//! connection to the server, runs the handshake, and exposes
//! connection state to consumer tiles.
//!
//! **Platform service, not a tile feature.** This module is
//! deliberately tile-agnostic. The terminal tile is the first
//! consumer; future tiles (Claude feed, agent presence) will be
//! the second, third, … consumers. None of them get privileged
//! access to the connection — they all read connection state
//! from `ConnectionStatus` context and (in a future slice) send
//! / subscribe through a `WsClient` context that's identical
//! shape for every tile kind.
//!
//! Slice 9s.2 ships the lifecycle (open → handshake → flip
//! `ConnectionStatus.connected`) and nothing else. The
//! tile-side send/subscribe API ships in 9s.3 alongside the
//! first concrete consumer (terminal), per
//! `feedback_no_premature_generalization`. Designing the API
//! against zero consumers is how you build a framework instead
//! of a protocol; designing it against one real consumer is
//! how you build the right shape.
//!
//! Lifecycle is tied to `AuthPhase`: connect on `SignedIn`,
//! disconnect on anything else. A future logout slice will
//! drive the disconnect side; today the connection just lives
//! for the duration of the page load (until a manual reload
//! or tab close).

use crate::{AuthPhase, AuthState, ConnectionStatus};
use futures_util::{SinkExt, StreamExt};
use gloo_net::websocket::{futures::WebSocket, Message};
use katulong_shared::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use leptos::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::console;

/// Spawn the WS lifecycle effect from the App root.
///
/// Reads `AuthState`, watches the phase, opens a connection on
/// the first `SignedIn` transition. The effect re-fires on
/// phase changes; we use a local guard to avoid stacking
/// connections if the phase pings back and forth.
///
/// Today we open exactly one connection per page load. Reconnect
/// on disconnect, and disconnect-on-logout, are deferred (the
/// hooks are obvious — `set_connected.set(false)` on stream
/// end, an effect that closes the WS on `SignedOut` — but
/// adding them now without a logout slice to validate against
/// would be untested code).
pub fn install(auth: AuthState, status: ConnectionStatus) {
    // The effect's own return value tracks "started" across
    // re-runs. `Fn` closures can't capture-and-mutate, so we
    // thread the started flag through Leptos's prev-value
    // mechanism instead of using `Cell` or a stash signal.
    create_effect(move |prev: Option<bool>| -> bool {
        let already_started = prev.unwrap_or(false);
        if already_started {
            return true;
        }
        if !matches!(auth.phase.get(), AuthPhase::SignedIn) {
            return false;
        }
        spawn_local(run_connection(status.set_connected));
        true
    });
}

/// Open the WS, run the Hello/HelloAck handshake, then loop
/// until the connection closes. On exit (normal or error) the
/// `connected` signal flips back to `false` — a future
/// reconnect slice can listen for this and re-call
/// `run_connection`.
async fn run_connection(set_connected: WriteSignal<bool>) {
    let url = match websocket_url() {
        Some(u) => u,
        None => {
            console::warn_1(&"katulong: cannot resolve WS URL from window".into());
            return;
        }
    };

    let ws = match WebSocket::open(&url) {
        Ok(ws) => ws,
        Err(err) => {
            console::warn_1(&format!("katulong: WS open failed: {err}").into());
            return;
        }
    };

    let (mut sink, mut stream) = ws.split();

    // Three-step handshake. Server → Hello, Client → HelloAck,
    // (Server validates, no third step from server until Attach
    // — the tile slice 9s.3 will send Attach when a terminal
    // tile mounts).
    let hello = match next_server_message(&mut stream).await {
        Ok(msg) => msg,
        Err(err) => {
            console::warn_1(&format!("katulong: WS hello receive failed: {err}").into());
            return;
        }
    };
    match hello {
        ServerMessage::Hello { protocol_version } if protocol_version == PROTOCOL_VERSION => {
            // Send HelloAck — the server re-validates the version
            // and closes on mismatch.
            if let Err(err) = send_client_message(
                &mut sink,
                &ClientMessage::HelloAck {
                    protocol_version: PROTOCOL_VERSION.to_string(),
                },
            )
            .await
            {
                console::warn_1(&format!("katulong: WS hello_ack send failed: {err}").into());
                return;
            }
        }
        ServerMessage::Hello { protocol_version } => {
            console::warn_1(
                &format!(
                    "katulong: WS protocol version mismatch — server speaks {protocol_version}, client expects {PROTOCOL_VERSION}",
                )
                .into(),
            );
            return;
        }
        other => {
            console::warn_1(
                &format!("katulong: WS first frame was not Hello: {other:?}").into(),
            );
            return;
        }
    }

    // Handshake complete — the connection is live.
    set_connected.set(true);

    // Drain incoming frames until the stream ends. Today this
    // loop only logs unexpected messages; the tile-side
    // subscribe API in 9s.3 will replace the body with a
    // dispatch that routes by message type to interested
    // tiles.
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Bytes(bytes)) => match decode_server_message(&bytes) {
                Ok(server_msg) => {
                    // Future: route to subscribed tiles.
                    let _ = server_msg;
                }
                Err(err) => {
                    console::warn_1(
                        &format!("katulong: WS decode failed: {err}").into(),
                    );
                }
            },
            Ok(Message::Text(t)) => {
                // Server uses CBOR exclusively; text frames are a
                // protocol violation.
                console::warn_1(
                    &format!("katulong: WS unexpected text frame: {t}").into(),
                );
            }
            Err(err) => {
                console::warn_1(&format!("katulong: WS stream error: {err}").into());
                break;
            }
        }
    }

    // Stream ended — connection closed. Flip the signal back so
    // the UI's `connected` state matches reality.
    set_connected.set(false);
}

/// Receive the next CBOR-encoded ServerMessage from the WS
/// stream, or return an error string suitable for logging.
async fn next_server_message<S>(stream: &mut S) -> Result<ServerMessage, String>
where
    S: StreamExt<Item = Result<Message, gloo_net::websocket::WebSocketError>> + Unpin,
{
    let frame = stream
        .next()
        .await
        .ok_or_else(|| "stream ended before first frame".to_string())?
        .map_err(|e| format!("ws error: {e}"))?;
    match frame {
        Message::Bytes(bytes) => decode_server_message(&bytes),
        Message::Text(t) => Err(format!(
            "expected binary frame (CBOR), got text frame: {t}"
        )),
    }
}

/// CBOR-decode a server message. Wire format is documented in
/// `katulong_shared::wire` (session-protocol section).
fn decode_server_message(bytes: &[u8]) -> Result<ServerMessage, String> {
    ciborium::de::from_reader(bytes).map_err(|e| format!("cbor decode: {e}"))
}

/// CBOR-encode a client message and send it over the WS sink.
async fn send_client_message<S>(
    sink: &mut S,
    msg: &ClientMessage,
) -> Result<(), String>
where
    S: SinkExt<Message, Error = gloo_net::websocket::WebSocketError> + Unpin,
{
    let mut buf = Vec::new();
    ciborium::ser::into_writer(msg, &mut buf).map_err(|e| format!("cbor encode: {e}"))?;
    sink.send(Message::Bytes(buf))
        .await
        .map_err(|e| format!("ws send: {e}"))
}

/// Compute the `ws://` or `wss://` URL for the same-origin
/// `/ws` endpoint. Same-scheme convention (HTTP → WS, HTTPS →
/// WSS) preserves cookie auth and matches the Origin check on
/// the server side.
fn websocket_url() -> Option<String> {
    let window = web_sys::window()?;
    let location = window.location();
    let protocol = location.protocol().ok()?;
    let host = location.host().ok()?;
    let scheme = if protocol == "https:" { "wss" } else { "ws" };
    Some(format!("{scheme}://{host}/ws"))
}
