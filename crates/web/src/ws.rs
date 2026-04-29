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

/// Hard ceiling on inbound WS-frame bytes the WASM client will
/// decode. 1 MiB matches the project's HTTP body cap; the server
/// already chunks `Output` payloads well below this (see the
/// session-layer coalescer in `crates/server/src/session/output.rs`),
/// so legitimate frames are nowhere near the limit. The cap defends
/// the WASM tab against a compromised server (or a protocol-confused
/// intermediary) that emits a giant byte-string and forces
/// `ciborium::de::from_reader` to allocate to OOM. Defense in depth
/// — the trust boundary upstream is same-origin + WSS, but a
/// browser-tab DoS doesn't need a malicious server, just a buggy
/// one.
const MAX_INBOUND_FRAME_BYTES: usize = 1 << 20;

/// Truncate a server-controlled string before logging to the JS
/// console. The unexpected-text-frame paths in this module log the
/// frame contents to aid operator triage; if a misconfigured tunnel
/// ever bleeds an HTTP error body into the WS stream, that body
/// might carry server banners, config hints, or token values. Cap
/// at 128 chars and replace anything outside printable ASCII with a
/// `?` so a binary blob doesn't render as garbage in the console
/// (and so an operator copying the line into a bug report doesn't
/// paste in a token).
fn sanitize_for_log(s: &str) -> String {
    s.chars()
        .take(128)
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// Spawn the WS lifecycle effect from the App root.
///
/// Reads `AuthState`, watches the phase, opens a connection on the
/// first `SignedIn` transition. The effect re-fires on phase changes;
/// the prev-value of the closure tracks "started" so we don't stack
/// connections if the phase pings back and forth.
///
/// **Logout-slice obligation.** The `already_started` latch is
/// one-way: once a connection has been spawned, the effect returns
/// `true` forever. A future logout slice that writes
/// `set_phase.set(SignedOut)` and then `set_phase.set(SignedIn)`
/// (the next sign-in) will see `already_started == true` and skip
/// the spawn — the user lands on the post-auth view with a dead
/// WS. The fix lives with the logout slice, not here:
/// (a) signal the in-flight `run_connection` task to close on
///     `SignedOut` (an `AbortController`-style oneshot or a shared
///     `AtomicBool` the async task polls), AND
/// (b) replace this prev-value latch with a `RwSignal<bool>` that
///     the logout path can clear before the next sign-in.
/// Doing only one of those leaves the bug in place. This obligation
/// is also flagged in the inline comment at the `return true`
/// branch and in `TODO.md` (rust-rewrite follow-ups, "WS lifecycle
/// reconnect / logout-clear").
///
/// Today we open exactly one connection per page load and let the
/// page reload handle re-establishment. Reconnect-on-disconnect is
/// the third related obligation (when a reconnect slice lands, it
/// must use exponential backoff with jitter to avoid self-DoS — see
/// `TODO.md`).
pub fn spawn_lifecycle(auth: AuthState, status: ConnectionStatus) {
    // The effect's own return value tracks "started" across
    // re-runs. `Fn` closures can't capture-and-mutate, so we thread
    // the started flag through Leptos's prev-value mechanism
    // instead of using `Cell` or a stash signal.
    create_effect(move |prev: Option<bool>| -> bool {
        let already_started = prev.unwrap_or(false);
        if already_started {
            // SEE the doc-comment above: this is the latch the
            // logout slice must replace. Returning `true`
            // unconditionally here means a `SignedOut → SignedIn`
            // cycle after this point will NOT re-spawn the
            // connection.
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
        Ok(u) => u,
        Err(reason) => {
            console::warn_1(
                &format!("katulong: cannot resolve WS URL: {reason}").into(),
            );
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

    // **Intentional silent discard, slice 9s.2 only.** No tile is
    // wired to consume `ServerMessage` yet — the next slice (9s.3,
    // real terminal) lands the dispatch that routes `Output` to
    // the focused TerminalTile, future ClaudeFeed events to the
    // feed tile, etc. In this slice's own operation no
    // post-handshake messages should arrive (the server doesn't
    // emit unsolicited frames between `Hello` and `Attach`, and
    // `Attach` lands in 9s.3), so the silent-discard branch is
    // unreachable in practice. We log at `warn` rather than panic
    // (`todo!()`) because (a) a panic crashes the WASM tab, (b) a
    // panic during the e2e suite's 5-second `data-status="connected"`
    // window would cause a flaky test failure that masks real
    // regressions, and (c) the warn is a positive signal to the
    // 9s.3 author that arriving messages are awaiting routing.
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Bytes(bytes)) => match decode_server_message(&bytes) {
                Ok(server_msg) => {
                    // 9s.3 replaces this branch with tile-side
                    // dispatch. Until then, log the type for
                    // operator triage of any unexpected arrival.
                    console::warn_1(
                        &format!(
                            "katulong: WS message received pre-9s.3 dispatch: {server_msg:?}"
                        )
                        .into(),
                    );
                }
                Err(err) => {
                    console::warn_1(
                        &format!("katulong: WS decode failed: {err}").into(),
                    );
                }
            },
            Ok(Message::Text(t)) => {
                // Server uses CBOR exclusively; text frames are a
                // protocol violation. Truncate + sanitize the
                // logged contents in case a misconfigured tunnel
                // bleeds an HTTP body into the WS stream.
                console::warn_1(
                    &format!(
                        "katulong: WS unexpected text frame: {}",
                        sanitize_for_log(&t)
                    )
                    .into(),
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
            "expected binary frame (CBOR), got text frame: {}",
            sanitize_for_log(&t)
        )),
    }
}

/// CBOR-decode a server message. Wire format is documented in
/// `katulong_shared::wire` (session-protocol section).
///
/// Frames larger than `MAX_INBOUND_FRAME_BYTES` are rejected before
/// `ciborium` runs — defends against a compromised or buggy server
/// that emits a giant byte-string and forces unbounded allocation.
fn decode_server_message(bytes: &[u8]) -> Result<ServerMessage, String> {
    if bytes.len() > MAX_INBOUND_FRAME_BYTES {
        return Err(format!(
            "frame exceeds {MAX_INBOUND_FRAME_BYTES} bytes (got {} bytes)",
            bytes.len()
        ));
    }
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
///
/// Returns a specific error string per failure mode so a
/// production triage of "WS never connected" can read the
/// console and identify which step of URL resolution failed.
/// Only `http:` and `https:` protocols are supported — `file:`,
/// `blob:`, and other non-HTTP schemes return an error rather
/// than producing a malformed `ws://` URL with an empty host.
fn websocket_url() -> Result<String, String> {
    let window = web_sys::window().ok_or("no window object")?;
    let location = window.location();
    let protocol = location
        .protocol()
        .map_err(|_| "location.protocol() unavailable".to_string())?;
    let host = location
        .host()
        .map_err(|_| "location.host() unavailable".to_string())?;
    let scheme = match protocol.as_str() {
        "https:" => "wss",
        "http:" => "ws",
        other => {
            return Err(format!(
                "unsupported page protocol {other:?} (expected http: or https:)"
            ))
        }
    };
    Ok(format!("{scheme}://{host}/ws"))
}
