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
use futures_channel::mpsc;
use futures_util::{SinkExt, StreamExt};
use gloo_net::websocket::{futures::WebSocket, Message};
use katulong_shared::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
use leptos::*;
use std::cell::RefCell;
use std::rc::Rc;
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

// =====================================================================
// Tile-side send/subscribe API.
//
// Tiles consume the connection through `WsClient`, the platform's
// shared context. There are exactly two operations:
//
// - `ws.send(ClientMessage)` queues an outbound message into the
//   send channel. The lifecycle task drains the channel into the
//   WS sink. Returns immediately; if the connection is dead or
//   reconnecting, the message buffers in the channel until either
//   it can be sent or the channel itself is dropped.
//
// - `ws.subscribe(callback)` registers a callback invoked for every
//   decoded `ServerMessage`. The caller filters by message variant
//   and any descriptor-specific keys (e.g., `Output.session_id`)
//   inside the callback. Returns a `SubscriberHandle` whose `Drop`
//   impl auto-unsubscribes — RAII tied to the caller's scope.
//
// The shape stays minimal because the alternative (centralised
// routing inside the platform: filter trees keyed by message variant
// + tile-id) would require the platform to know what each tile kind
// cares about. That's the framework-not-protocol failure mode —
// every new tile would force the platform to grow. With the
// callback shape, terminal tiles filter on `session_id`, future
// Claude-feed tiles will filter on topic, the platform stays tile-
// kind-agnostic.
//
// **Re-entrancy.** The receive loop dispatches messages to
// subscribers while holding a `RefCell::borrow()` on the subscriber
// list. A subscriber callback that itself calls `ws.subscribe(...)`
// would attempt `borrow_mut()` while we hold `borrow()` — `RefCell`
// panics on overlapping borrow modes. In practice no tile does
// this; subscriptions register at component mount, not from inside
// a message callback. The pattern is documented; if a future tile
// genuinely needs nested subscription, the receive loop should
// snapshot the subscriber list (via a clone) before dispatch.
// =====================================================================

/// The platform's shared WS handle. Cloneable so multiple tiles
/// can hold one without coordination; clones share the same
/// underlying channel and subscriber list.
#[derive(Clone)]
pub struct WsClient {
    sender: mpsc::UnboundedSender<ClientMessage>,
    subscribers: SubscriberList,
}

/// Internal subscriber registry. `Rc<RefCell<...>>` is fine in
/// WASM (single-threaded); the lifetime is tied to the WsClient
/// clones, which the App-root context owns for the page's
/// lifetime.
#[derive(Clone, Default)]
struct SubscriberList(Rc<RefCell<Vec<Subscriber>>>);

struct Subscriber {
    id: u64,
    callback: Box<dyn Fn(&ServerMessage)>,
}

/// RAII handle returned by `WsClient::subscribe`. Dropping
/// it removes the subscriber from the dispatch list. Tile
/// components keep the handle alive via `store_value` so it
/// lives as long as the component scope; the handle's `Drop`
/// fires on scope dispose, automatically cleaning up.
pub struct SubscriberHandle {
    id: u64,
    subscribers: SubscriberList,
}

impl Drop for SubscriberHandle {
    fn drop(&mut self) {
        self.subscribers
            .0
            .borrow_mut()
            .retain(|s| s.id != self.id);
    }
}

impl WsClient {
    /// Queue a client message for the WS connection. Non-blocking;
    /// the message rides the send channel and the lifecycle task
    /// drains it into the WS sink. If the connection is dead
    /// (channel receiver dropped), the send is silently lost — the
    /// `data-status="connected"` indicator surfaces the disconnected
    /// state, so a tile that observes a non-effect from a `send` is
    /// expected to also observe `ConnectionStatus.connected = false`.
    ///
    /// **Back-pressure / delivery contract.** `send` returns `()`,
    /// not `Result<(), ...>`. Callers that need delivery
    /// confirmation should gate on `ConnectionStatus.connected`
    /// BEFORE the call, not after — checking after is racy (the
    /// connection could die between the check and the next call).
    /// Today's only consumer (TerminalTile's `Attach`) tolerates
    /// silent failure because a failed Attach manifests as no
    /// Output frames arriving, which the user observes as an
    /// empty terminal alongside the disconnected indicator. When
    /// a future tile needs a stronger guarantee, the right
    /// upgrade is to add a `send_with_ack(...)` helper that
    /// returns a future resolving on `ServerMessage` echo, not
    /// to change this method's signature.
    pub fn send(&self, msg: ClientMessage) {
        // `unbounded_send` only fails when the receiver has been
        // dropped (lifecycle task ended). That case is observable
        // via `ConnectionStatus`; logging here would be redundant.
        let _ = self.sender.unbounded_send(msg);
    }

    /// Register a callback for every decoded inbound message.
    /// Returns a handle whose `Drop` removes the subscriber.
    /// Callers that want their subscription tied to a Leptos
    /// component scope should keep the handle in `store_value`.
    pub fn subscribe<F>(&self, callback: F) -> SubscriberHandle
    where
        F: Fn(&ServerMessage) + 'static,
    {
        // ID generation: monotonic counter on the subscribers list.
        // We keep IDs in the Subscriber rather than relying on
        // pointer identity because pointer identity changes if a
        // subscriber is moved (and Box pointers can be moved).
        let id = next_subscriber_id();
        self.subscribers.0.borrow_mut().push(Subscriber {
            id,
            callback: Box::new(callback),
        });
        SubscriberHandle {
            id,
            subscribers: self.subscribers.clone(),
        }
    }
}

/// Process-wide subscriber id counter. Could live in
/// `SubscriberList` but a free counter is simpler and the IDs
/// don't need to be unique across WsClient instances (there's
/// only ever one WsClient per page anyway).
///
/// `Cell<u64>` rather than `thread_local!` because WASM is
/// single-threaded — `thread_local!` would imply per-thread
/// isolation that doesn't exist here, misleading future
/// readers into thinking there's a multi-thread concern.
fn next_subscriber_id() -> u64 {
    use std::cell::Cell;
    thread_local! {
        // We do still need `thread_local!` for the
        // module-level static because Rust's `static` requires
        // `Sync` for non-Cell types, and `Cell` is `!Sync`.
        // The thread-local wrapper is the standard escape
        // hatch for "single-threaded mutable static" — not a
        // statement about thread isolation, just about the
        // type-system constraint. Single-threaded WASM only
        // ever has one thread to begin with.
        static NEXT_ID: Cell<u64> = const { Cell::new(0) };
    }
    NEXT_ID.with(|c| {
        let id = c.get() + 1;
        c.set(id);
        id
    })
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
    // Channel + subscriber list are created here so they're
    // available BEFORE the connection comes up — tiles can call
    // `ws.send(...)` / `ws.subscribe(...)` immediately on mount;
    // the channel buffers sends until the lifecycle task drains
    // it, and the subscriber list is read by the receive loop
    // when frames arrive.
    let (sender, receiver) = mpsc::unbounded::<ClientMessage>();
    let subscribers = SubscriberList::default();
    provide_context(WsClient {
        sender,
        subscribers: subscribers.clone(),
    });

    // The receiver is single-use (mpsc unbounded), so we move it
    // into the lifecycle task on the first `SignedIn` transition.
    // `RefCell<Option<...>>` lets a `Fn`-bounded effect closure
    // take ownership exactly once.
    let receiver_slot = Rc::new(RefCell::new(Some(receiver)));

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
        let receiver = receiver_slot
            .borrow_mut()
            .take()
            .expect("ws receiver already taken — install effect re-fired");
        spawn_local(run_connection(
            status.set_connected,
            receiver,
            subscribers.clone(),
        ));
        true
    });
}

/// Open the WS, run the Hello/HelloAck handshake, then split
/// into two cooperating tasks: a send-loop draining the
/// outbound channel into the sink, and a receive-loop draining
/// the stream and dispatching to subscribers. On exit (stream
/// end or error) the `connected` signal flips back to `false`.
///
/// Two cooperating tasks rather than `select!` over both
/// directions because (a) `futures-util`'s `select!` macro
/// requires the `select` feature flag we don't currently
/// pull in, (b) two linear `while let` loops are easier to
/// read than a select arm, and (c) the only synchronisation
/// point we need is "did the receive-loop end" — that flips
/// `connected = false`, which the send-loop observes via
/// channel close (its sink errors when the WS dies).
async fn run_connection(
    set_connected: WriteSignal<bool>,
    receiver: mpsc::UnboundedReceiver<ClientMessage>,
    subscribers: SubscriberList,
) {
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

    // Send loop: drain `receiver` (channel from `WsClient::send`
    // calls in tile components) into the WS sink. Spawned as a
    // separate task so it doesn't block the receive loop.
    //
    // On sink error we ALSO flip `set_connected.set(false)` —
    // otherwise the asymmetric failure (sink dies, stream
    // continues) would leave the UI showing "connected" while
    // every send silently fails. Both halves share one underlying
    // WebSocket; in practice the stream sees the close shortly
    // after, but flipping connected here makes the UI honest
    // immediately.
    spawn_local(async move {
        let mut sink = sink;
        let mut receiver = receiver;
        while let Some(msg) = receiver.next().await {
            if let Err(err) = send_client_message(&mut sink, &msg).await {
                console::warn_1(
                    &format!("katulong: WS send_loop write failed: {err}").into(),
                );
                set_connected.set(false);
                break;
            }
        }
        // Channel closed (all WsClient clones dropped) is a
        // graceful exit — no `set_connected` write needed; the
        // receive loop owns the disconnect signalling on the
        // graceful path.
    });

    // Receive loop: drain `stream`, dispatch each successfully
    // decoded `ServerMessage` to every subscriber. Subscribers
    // filter by message variant + descriptor-specific keys (e.g.,
    // a TerminalTile callback matches on
    // `ServerMessage::Output { .. }` whose session matches its
    // `session_id` prop).
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Bytes(bytes)) => match decode_server_message(&bytes) {
                Ok(server_msg) => dispatch_to_subscribers(&subscribers, &server_msg),
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

/// Invoke every subscriber's callback with the message. Borrows
/// the subscriber list immutably; subscribers must NOT call
/// `WsClient::subscribe` from inside their callback (would
/// trigger a `RefCell` borrow conflict). The pattern is
/// documented at the module level.
fn dispatch_to_subscribers(subscribers: &SubscriberList, msg: &ServerMessage) {
    let subs = subscribers.0.borrow();
    for s in subs.iter() {
        (s.callback)(msg);
    }
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
