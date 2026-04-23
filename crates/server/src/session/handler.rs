//! Per-connection session handler.
//!
//! `serve_session` consumes a `TransportHandle` and runs the
//! terminal-session lifecycle against it: protocol handshake,
//! session attach, output forwarding, input forwarding, resize
//! gating, and revocation watch. It is transport-agnostic by
//! construction — see `project_transport_agnostic` in project
//! memory.
//!
//! # What's in scope
//!
//! - **Handshake gate** (slice 9e): `Hello` (server) → `HelloAck`
//!   (client) → `Attach` (client) → `Attached` (server). The
//!   phase state machine enforces the order; messages arriving
//!   in the wrong phase trigger a typed `Error` and clean close.
//! - **Output forwarding** (slice 9f): after `Attached`, the
//!   handler subscribes to `state.output_router` for its pane
//!   and forwards decoded bytes through the coalescer to
//!   `ServerMessage::Output { data, seq }`. `seq` is per-
//!   connection-monotonic (Node scar `da6907f` — lets the
//!   client detect gaps on reconnect).
//! - **Output coalescing** (slice 9f): buffer bursts with a
//!   2 ms idle / 16 ms cap schedule (Node scars
//!   `d311168`/`066dab2`). Individual `%output` chunks below
//!   the idle window fuse into one wire message; continuous
//!   streams still flush every 16 ms.
//! - **Input forwarding** (slice 9f): `ClientMessage::Input`
//!   bytes go to `SessionManager::send_input`, which encodes
//!   them as `send-keys -t %<pane_id> -H <hex>`. Binary-safe —
//!   control chars, arrow keys, Ctrl-C all traverse correctly.
//! - **Resize gating** (slice 9f): `ClientMessage::Resize`
//!   applies immediately if no output landed within 50 ms;
//!   otherwise defers until output has been idle for 50 ms OR
//!   500 ms have elapsed (whichever is sooner). Node scar
//!   `066dab2` — SIGWINCH mid-render interleaves old and new
//!   paint sequences; the gate avoids that.
//! - **Revocation watch**: `tokio::select!` over `handle.inbound`
//!   and `state.subscribe_revocations()` closes the transport on
//!   matching credential. Localhost connections have no
//!   credential binding and are immune to revoke events.
//!
//! # Not in scope (deferred)
//!
//! - **Multi-device output fan-out** (slice 9h): the router
//!   replaces on a second subscribe (attach-displaces-prior)
//!   rather than fanning out. Slice 9h needs a product
//!   decision on replace-vs-fanout for simultaneous devices.
//! - **Pane eviction on tmux-pane-gone** (slice 9h): today a
//!   `clear_subscriber` keeps the ring alive indefinitely; a
//!   server restart is the wipe mechanism. Wiring `%window-
//!   close`/`%pane-close` notifications into
//!   `OutputRouter::evict` closes the long-running-server
//!   leak path.
//! - **Session-creation rate cap**: an authenticated client can
//!   create unbounded tmux sessions, each allocating a ring.
//!   Tracked as a separate hardening ticket.
//!
//! # Why a state machine, not "just check in the match"
//!
//! The alternative is per-variant guards like `if !attached {
//! return Err(unexpected) }` scattered through the main loop.
//! That works but makes it easy to forget a guard on a newly-
//! added variant. The phase enum + `Action` values force every
//! addition to be placed in a phase, and the unit tests below
//! snap whenever a variant crosses phases without explicit
//! consent.

use crate::log_util::sanitize_for_log;
use crate::revocation::RevocationEvent;
use crate::session::output::Coalescer;
use crate::session::ring::ReplaySlice;
use crate::session::router::{OutputChunk, SubscribeError, SubscriberId};
use crate::state::AppState;
use crate::transport::{ClientMessage, ServerMessage, TransportHandle, PROTOCOL_VERSION};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// How long we wait between connection upgrade and receiving
/// `HelloAck` before closing. WS-level keepalive keeps the socket
/// alive indefinitely; without this a silent peer can pin a
/// connection forever. Generous enough that a high-latency real
/// client completes well within it; short enough that a scraper
/// probing `/ws` with no cookie (shouldn't happen — auth gates the
/// upgrade) or a half-open connection is reaped promptly.
const HANDSHAKE_TIMEOUT_SECS: u64 = 10;

/// Output-idle window before a pending resize can apply. Node
/// scar `066dab2`: SIGWINCH arriving mid-render interleaves old
/// partial-frame escapes with the new redraw, garbling TUI apps.
/// Waiting 50 ms after the last output byte lets in-flight paints
/// complete before the resize punches through.
const RESIZE_GATE: Duration = Duration::from_millis(50);

/// Cap on how long a pending resize can wait for output-idle.
/// Without this, a continuous-output command like `tail -f` (which
/// keeps resetting the idle window) starves resize forever. Same
/// Node scar (`066dab2`): 500 ms is short enough to feel
/// responsive yet long enough that any interactive TUI would have
/// paused between frames.
const RESIZE_MAX_DEFER: Duration = Duration::from_millis(500);

/// Cap on the protocol-version string we echo back in error
/// messages. Far shorter than the Origin cap in `ws.rs` because the
/// version string is a short identifier (`"katulong/0.1"`) — if a
/// client sends something larger, it's either buggy or crafted, and
/// 32 chars is plenty to identify the prefix without letting an
/// attacker flood logs with per-request megabyte payloads.
const LOG_PROTOCOL_VERSION_MAX_LEN: usize = 32;

/// Error codes emitted as `ServerMessage::Error.code`. Stable —
/// clients and scripts key off these strings, so renames require a
/// protocol version bump.
pub mod error_code {
    /// Client's `HelloAck.protocol_version` didn't match what the
    /// server speaks. The connection closes immediately.
    pub const PROTOCOL_VERSION_MISMATCH: &str = "protocol_version_mismatch";
    /// Client sent a message that isn't allowed in the current
    /// handshake phase (e.g., `Input` before `Attached`).
    pub const UNEXPECTED_MESSAGE: &str = "unexpected_message";
    /// Client tried to `Attach` to a session name that the
    /// session-name validator rejected.
    pub const INVALID_SESSION: &str = "invalid_session";
    /// The session manager (tmux) rejected an operation. Body is
    /// generic on purpose — raw tmux stderr must not leak to
    /// clients.
    pub const SESSION_ERROR: &str = "session_error";
    /// No session manager is wired into this server (misconfig or
    /// tmux binary missing). Only surfaces during development.
    pub const NO_SESSION_MANAGER: &str = "no_session_manager";
    /// Client didn't complete the handshake within
    /// `HANDSHAKE_TIMEOUT_SECS`. Connection closes.
    pub const HANDSHAKE_TIMEOUT: &str = "handshake_timeout";
    /// Client sent `Attach { resume_from_seq: Some(N) }` with
    /// `N` larger than the pane's `total_written`. A
    /// correctly-implemented client cannot reach this — the seq
    /// only ever comes from a prior `Attached.last_seq` or
    /// `Output.seq`, both of which the server assigned. Closing
    /// on mismatch catches version-skew or client bugs early.
    pub const INVALID_RESUME: &str = "invalid_resume";
    /// Attach rejected because the pane already has the maximum
    /// number of concurrent subscribers (slice 9h multi-device
    /// fan-out cap). Clients should close the connection and
    /// prompt the user if they want to disconnect one of their
    /// other devices.
    pub const SESSION_OVERSUBSCRIBED: &str = "session_oversubscribed";
    /// Connection was torn down server-side without the client
    /// having done anything wrong. Emitted when the bound
    /// credential is revoked, or when the revocation broadcast
    /// subscriber falls behind (`Lagged`) and we conservatively
    /// close rather than risk missing a real revoke.
    ///
    /// **Why not dedicate codes per cause?** An operator-side
    /// distinction between "revoked" and "lagged" is useful in
    /// logs, but exposing it on the wire leaks "yes, your
    /// credential was revoked" to whoever holds the socket. We
    /// reuse this code for both, and the per-cause detail lives
    /// only in the server's tracing output (see `handle_revoke`).
    /// Clients key off this code to know that **auto-reconnect
    /// without fresh auth is futile** — distinct from
    /// `UNEXPECTED_MESSAGE`, which is a "fix your message" retry
    /// signal.
    pub const CONNECTION_TERMINATED: &str = "connection_terminated";
}

/// Handshake phase. Advances on valid messages; any message that
/// isn't valid for the current phase is a protocol violation.
///
/// The `Attached` variant is intentionally data-less: the session
/// name and pane id live in the coordinator's `AttachedState`
/// alongside async resources (the pane output receiver, the
/// coalescer, the resize timer state) that can't sit in a
/// clonable phase enum. The phase is the "protocol gate"; the
/// I/O state is the "active work."
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// Server has sent `Hello`; waiting for the client to ack with
    /// a matching protocol version.
    AwaitingHelloAck,
    /// Protocol version confirmed; waiting for the client to send
    /// `Attach` with a session name and dimensions.
    AwaitingAttach,
    /// Transport is bound to a tmux pane. `Input`/`Resize` are now
    /// valid. The pane id + session name + output subscription
    /// live in the coordinator's `AttachedState`.
    Attached,
}

/// Action the phase machine tells the coordinator to take after
/// processing a client message. Keeps the state machine a pure
/// function of (phase, message) — no `.await`, no I/O — so the
/// coordinator owns every side effect. This makes `step` trivial
/// to unit-test without a real tmux, real socket, or runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Action {
    /// Nothing to emit; keep reading.
    Continue,
    /// Echo a `Pong` with the given nonce.
    SendPong(u64),
    /// Protocol version checked out; reply confirmation is
    /// implicit (no server message is sent for HelloAck — the
    /// client's next move is Attach). Just advance phase.
    AdvanceToAwaitingAttach,
    /// Create/attach the tmux session, subscribe to its pane,
    /// then send `Attached` with the clamped dims. If
    /// `resume_from_seq` is `Some(N)` the coordinator asks the
    /// router for a replay slice and emits `OutputGap` +
    /// replay `Output` before going live.
    DoAttach {
        session: String,
        cols: u16,
        rows: u16,
        resume_from_seq: Option<u64>,
    },
    /// Forward client input bytes to the attached pane.
    ForwardInput { data: Vec<u8> },
    /// Queue a resize for the attached session — the coordinator
    /// applies immediately or defers based on the resize gate.
    QueueResize { cols: u16, rows: u16 },
    /// A protocol violation. Coordinator sends `Error` and closes.
    /// `code` is one of `error_code::*`; `message` is operator-
    /// visible and MUST NOT include client-controlled bytes raw
    /// (log-injection path — the coordinator sanitizes).
    Close { code: &'static str, message: String },
    /// Client pipeline signalled that their end of the
    /// transport closed or decoded a frame error. Coordinator
    /// exits without emitting anything.
    Exit,
}

/// Pure state-machine step: given the current phase and a client
/// message, decide what to do next. No awaits, no side effects, no
/// SessionManager reference — keeps this function easy to test and
/// impossible to accidentally deadlock.
fn step(phase: &mut Phase, msg: ClientMessage) -> Action {
    match (phase.clone(), msg) {
        // `Ping` is allowed in every phase. It never changes phase
        // and doesn't touch any session state.
        (_, ClientMessage::Ping { nonce }) => Action::SendPong(nonce),

        (Phase::AwaitingHelloAck, ClientMessage::HelloAck { protocol_version }) => {
            if protocol_version == PROTOCOL_VERSION {
                *phase = Phase::AwaitingAttach;
                Action::AdvanceToAwaitingAttach
            } else {
                Action::Close {
                    code: error_code::PROTOCOL_VERSION_MISMATCH,
                    message: format!(
                        "server speaks {}, client acked {}",
                        PROTOCOL_VERSION,
                        sanitize_for_log(&protocol_version, LOG_PROTOCOL_VERSION_MAX_LEN),
                    ),
                }
            }
        }

        (
            Phase::AwaitingAttach,
            ClientMessage::Attach {
                session,
                cols,
                rows,
                resume_from_seq,
            },
        ) => Action::DoAttach {
            session,
            cols,
            rows,
            resume_from_seq,
        },

        (Phase::Attached, ClientMessage::Input { data }) => Action::ForwardInput { data },

        (Phase::Attached, ClientMessage::Resize { cols, rows }) => {
            Action::QueueResize { cols, rows }
        }

        // Any other (phase, message) combination is a protocol
        // violation. We match on the phase purely to produce a
        // descriptive error — the message itself is untrusted.
        (phase, msg) => Action::Close {
            code: error_code::UNEXPECTED_MESSAGE,
            message: format!(
                "client sent {} while server was {}",
                variant_name(&msg),
                phase_name(&phase),
            ),
        },
    }
}

fn variant_name(msg: &ClientMessage) -> &'static str {
    match msg {
        ClientMessage::Ping { .. } => "ping",
        ClientMessage::HelloAck { .. } => "hello_ack",
        ClientMessage::Attach { .. } => "attach",
        ClientMessage::Input { .. } => "input",
        ClientMessage::Resize { .. } => "resize",
    }
}

fn phase_name(phase: &Phase) -> &'static str {
    match phase {
        Phase::AwaitingHelloAck => "awaiting_hello_ack",
        Phase::AwaitingAttach => "awaiting_attach",
        Phase::Attached => "attached",
    }
}

/// Per-connection I/O state populated after a successful `Attach`.
/// Holds every resource that can't sit in `Phase::Attached`
/// (async receivers, timing state, mutable buffers).
///
/// Drop behavior is load-bearing: dropping `AttachedState` drops
/// the `mpsc::Receiver`, which tells the router the subscriber is
/// gone; the explicit `unsubscribe` call in `serve_session`'s
/// cleanup removes the decoder too. Never return early from
/// `serve_session` without passing through the cleanup path.
struct AttachedState {
    session: String,
    pane_id: u32,
    /// This subscriber's id, handed back by the router on
    /// subscribe. Used at cleanup to remove ONLY this
    /// connection's sender from the pane's fan-out list,
    /// leaving sibling subscribers (multi-device) untouched.
    subscriber_id: SubscriberId,
    /// Decoded bytes + end-of-chunk seq from this pane's
    /// `%output` stream. The router fans out an `Arc<OutputChunk>`
    /// per dispatch so every subscriber gets the same bytes
    /// without per-subscriber allocation; the handler only
    /// reads through the Arc, never mutates.
    output_rx: mpsc::Receiver<Arc<OutputChunk>>,
    /// Highest `end_seq` we've seen come out of `output_rx`.
    /// When the coalescer flushes, this becomes the outbound
    /// `ServerMessage::Output.seq`. Starts at the router's
    /// `last_seq` snapshot at attach time so a reconnect with
    /// replay doesn't emit seqs below the replay's `last_seq`.
    last_seen_seq: u64,
    /// Coalesces raw bytes from `output_rx` into chunky Output
    /// messages. See `output::Coalescer` for timing.
    coalescer: Coalescer,
    /// When we last received bytes from `output_rx`. `None` until
    /// the first chunk lands. Used by the resize gate — a resize
    /// that arrives within `RESIZE_GATE` of this time defers.
    last_output_at: Option<Instant>,
    /// Resize queued while output was recent. `None` means no
    /// resize waiting. The `queued_at` field lets us cap the
    /// deferral at `RESIZE_MAX_DEFER`.
    pending_resize: Option<PendingResize>,
}

struct PendingResize {
    cols: u16,
    rows: u16,
    queued_at: Instant,
}

impl AttachedState {
    /// When to flush the coalescer. `None` when no output is
    /// buffered.
    fn coalesce_deadline(&self) -> Option<Instant> {
        self.coalescer.next_deadline()
    }

    /// When to apply a pending resize. `None` when no resize is
    /// queued. The deadline is the earlier of:
    /// - `last_output_at + RESIZE_GATE` (apply after output idle)
    /// - `pending.queued_at + RESIZE_MAX_DEFER` (apply anyway)
    ///
    /// A pending resize with NO prior output (client resized
    /// before the shell had a chance to print) resolves
    /// immediately — use `queued_at` as both the "since output"
    /// and the "max defer" reference, yielding a past deadline.
    fn resize_deadline(&self) -> Option<Instant> {
        let pending = self.pending_resize.as_ref()?;
        let idle_target = self
            .last_output_at
            .map_or(pending.queued_at, |t| t + RESIZE_GATE);
        let cap_target = pending.queued_at + RESIZE_MAX_DEFER;
        Some(idle_target.min(cap_target))
    }
}

/// The per-connection consumer loop, parameterised on the
/// transport abstraction. `state` threads session manager +
/// revocation broadcast + output router; `credential_id` is the
/// credential this transport is bound to (from the auth
/// extractor), or `None` for localhost-exempt connections which
/// can't be revoked.
///
/// This function owns the `TransportHandle` for the connection's
/// lifetime. When it returns, the outbound sender drops → the WS
/// output pump sees the channel close → the socket closes.
pub async fn serve_session(
    state: AppState,
    handle: TransportHandle,
    credential_id: Option<String>,
) {
    let mut handle = handle;

    // Subscribe to revocation events BEFORE we touch anything else.
    // See `revocation.rs` subscriber contract.
    let mut revocations = state.subscribe_revocations();

    // Send the initial Hello. If this fails, the transport died
    // between upgrade and now — nothing to do.
    if handle
        .send(ServerMessage::Hello {
            protocol_version: PROTOCOL_VERSION.to_string(),
        })
        .await
        .is_err()
    {
        return;
    }

    let mut phase = Phase::AwaitingHelloAck;
    let mut attached: Option<AttachedState> = None;
    let handshake_deadline = Instant::now() + Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);

    loop {
        // Guard flags for conditional select branches. Assigning
        // to locals reads more clearly than inlining the matches
        // in the select macro (and rustc has been known to
        // misjudge `if matches!(...)` in select guards).
        let in_handshake = matches!(
            phase,
            Phase::AwaitingHelloAck | Phase::AwaitingAttach
        );
        let coalesce_deadline = attached.as_ref().and_then(|a| a.coalesce_deadline());
        let resize_deadline = attached.as_ref().and_then(|a| a.resize_deadline());

        let action = tokio::select! {
            biased;

            // Revocation takes precedence over any pending message
            // — a revoked credential's next keystroke should not
            // be processed, not even in the same tick where it
            // arrives alongside the revoke event.
            revoke = revocations.recv() => handle_revoke(revoke, credential_id.as_deref()),

            // Handshake-timer branch: only active while we're
            // still awaiting HelloAck or Attach.
            _ = tokio::time::sleep_until(handshake_deadline), if in_handshake => Action::Close {
                code: error_code::HANDSHAKE_TIMEOUT,
                message: "client did not complete handshake in time".into(),
            },

            // Coalescer flush: elapsed idle or cap deadline.
            // Second priority after revoke so a single slow
            // client can't stall a revocation.
            _ = sleep_until_opt(coalesce_deadline), if coalesce_deadline.is_some() => {
                Action::Continue  // handled below in post-select block
            }

            // Pending resize ready to apply.
            _ = sleep_until_opt(resize_deadline), if resize_deadline.is_some() => {
                Action::Continue  // handled below in post-select block
            }

            // Output from this pane. `maybe_recv_output` yields
            // `None` if the output channel closed (displacing
            // attach from another connection, or dispatcher
            // pruned us after a panic) — that MUST be a clean
            // exit, otherwise the loop sits forever on a dead
            // channel.
            chunk_opt = maybe_recv_output(attached.as_mut()) => match chunk_opt {
                Some(chunk) => {
                    if let Some(a) = attached.as_mut() {
                        a.last_output_at = Some(Instant::now());
                        a.coalescer.push(&chunk.data);
                        a.last_seen_seq = chunk.end_seq;
                    }
                    Action::Continue
                }
                None => {
                    tracing::info!(
                        cause = "output_channel_closed",
                        "session connection terminating"
                    );
                    Action::Exit
                }
            },

            msg = handle.inbound.recv() => match msg {
                None => Action::Exit,
                Some(Err(err)) => {
                    tracing::warn!(error = %err, "transport frame error; dropping");
                    Action::Continue
                }
                Some(Ok(msg)) => step(&mut phase, msg),
            },
        };

        // Post-select: coalescer flush + resize flush are driven
        // by deadlines, not `Action` values — the timer branches
        // above just wake the loop, and we check here whether the
        // deadline is actually past. This keeps the state machine
        // decoupled from timer wake-up without needing a new
        // Action variant per deadline kind.
        if let Some(a) = attached.as_mut() {
            let now = Instant::now();
            if a.coalesce_deadline().is_some_and(|d| now >= d) && !a.coalescer.is_empty() {
                let bytes = a.coalescer.take();
                // `last_seen_seq` already equals the end-seq of
                // the most recent chunk we folded into the
                // coalescer — by construction that's the end-seq
                // of the flushed batch's last byte.
                let seq = a.last_seen_seq;
                if handle
                    .send(ServerMessage::Output { data: bytes, seq })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            if a.resize_deadline().is_some_and(|d| now >= d) {
                let pending = a
                    .pending_resize
                    .take()
                    .expect("resize_deadline implies pending_resize is Some");
                let sessions = require_sessions(&state);
                if let Err(err) = sessions
                    .resize_session(&a.session, pending.cols, pending.rows)
                    .await
                {
                    tracing::warn!(
                        session = %a.session,
                        error = %err,
                        "deferred resize failed; keeping transport open"
                    );
                }
            }
        }

        match action {
            Action::Continue => continue,
            Action::Exit => break,
            Action::SendPong(nonce) => {
                if handle.send(ServerMessage::Pong { nonce }).await.is_err() {
                    break;
                }
            }
            Action::AdvanceToAwaitingAttach => {
                // No server message; the client already has Hello
                // and its next move is Attach.
                continue;
            }
            Action::DoAttach {
                session,
                cols,
                rows,
                resume_from_seq,
            } => {
                // Clamp once at the coordinator before dispatch.
                // SessionManager clamps internally too as
                // defense-in-depth (see its docstring).
                let (cols, rows) = crate::session::dims::clamp_dims(cols, rows);
                let Some(sessions) = state.sessions.as_deref() else {
                    send_error_and_close(
                        &handle,
                        error_code::NO_SESSION_MANAGER,
                        "session manager not configured".into(),
                    )
                    .await;
                    break;
                };
                let attach_outcome =
                    try_attach(sessions, &state, &session, cols, rows, resume_from_seq).await;
                match attach_outcome {
                    Ok(outcome) => {
                        let last_seq = outcome.last_seq();
                        let replay = outcome.replay;
                        attached = Some(outcome.new_state);
                        phase = Phase::Attached;
                        if handle
                            .send(ServerMessage::Attached {
                                session,
                                cols,
                                rows,
                                last_seq,
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                        // Replay any missed bytes. Must happen
                        // AFTER Attached so the client's clear-
                        // on-OutputGap logic fires in the right
                        // order.
                        if send_replay(&handle, replay).await.is_err() {
                            break;
                        }
                    }
                    Err(AttachFailure { code, message, err }) => {
                        tracing::warn!(
                            credential = credential_id.as_deref().unwrap_or("localhost"),
                            error = %err,
                            code = code,
                            "attach rejected"
                        );
                        send_error_and_close(&handle, code, message).await;
                        break;
                    }
                }
            }
            Action::ForwardInput { data } => {
                let a = attached
                    .as_ref()
                    .expect("Attached phase implies attached is Some");
                let sessions = require_sessions(&state);
                if let Err(err) = sessions.send_input(a.pane_id, &data).await {
                    // Forwarding failure is operator-visible but
                    // not a reason to close — a glitchy write may
                    // be followed by success on the next input,
                    // and closing would kick the user for tmux's
                    // transient failure.
                    tracing::warn!(
                        session = %a.session,
                        pane_id = a.pane_id,
                        credential = credential_id.as_deref().unwrap_or("localhost"),
                        error = %err,
                        "input forward failed; keeping transport open"
                    );
                }
            }
            Action::QueueResize { cols, rows } => {
                let a = attached
                    .as_mut()
                    .expect("Attached phase implies attached is Some");
                let (cols, rows) = crate::session::dims::clamp_dims(cols, rows);
                let now = Instant::now();
                let recent_output = a
                    .last_output_at
                    .is_some_and(|t| now.duration_since(t) < RESIZE_GATE);
                if !recent_output {
                    // No recent output — apply immediately. This
                    // is the initial-attach path (no output yet)
                    // and the quiet-shell path.
                    a.pending_resize = None;
                    let sessions = require_sessions(&state);
                    if let Err(err) = sessions.resize_session(&a.session, cols, rows).await {
                        tracing::warn!(
                            session = %a.session,
                            error = %err,
                            "resize failed; keeping transport open"
                        );
                    }
                } else {
                    // Defer: stash and let the timer branch
                    // pick it up. If a resize is already pending,
                    // overwrite — the most recent client
                    // dimensions win, and the queued_at stays at
                    // the oldest time so the 500 ms max-defer cap
                    // still applies from the first attempt (an
                    // attacker-paced resize every 400 ms should
                    // not extend the defer forever).
                    let queued_at = a
                        .pending_resize
                        .as_ref()
                        .map_or(now, |p| p.queued_at);
                    a.pending_resize = Some(PendingResize {
                        cols,
                        rows,
                        queued_at,
                    });
                }
            }
            Action::Close { code, message } => {
                send_error_and_close(&handle, code, message).await;
                break;
            }
        }
    }

    // Cleanup: detach THIS subscriber, but keep the pane's
    // ring, decoder, and sibling subscribers alive. Slice 9h:
    // `clear_subscriber` takes the SubscriberId so only this
    // connection's sender is removed. Multi-device sessions
    // (phone + laptop) keep flowing for the other devices
    // when one closes its transport.
    if let Some(a) = attached {
        state
            .output_router
            .clear_subscriber(a.pane_id, a.subscriber_id);
    }
    // Drop the handle. The WS output pump sees the channel close
    // and shuts down the socket gracefully.
}

/// Helper: await a deadline if set, otherwise never resolve. Used
/// in `tokio::select!` branches whose activation is guarded by a
/// `.is_some()` condition — the `pending` branch never actually
/// runs thanks to the guard, but its future still needs to be
/// constructable.
async fn sleep_until_opt(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending::<()>().await,
    }
}

/// Helper: read from the pane output receiver if we're attached,
/// otherwise never resolve. Same guard-+-pending pattern as
/// `sleep_until_opt`.
async fn maybe_recv_output(
    attached: Option<&mut AttachedState>,
) -> Option<Arc<OutputChunk>> {
    match attached {
        Some(a) => a.output_rx.recv().await,
        None => std::future::pending().await,
    }
}

/// Attach-result payload so the serve loop can branch cleanly on
/// the several ways `DoAttach` can go wrong.
struct AttachFailure {
    code: &'static str,
    message: String,
    /// Original error rendered as a string for tracing.
    err: String,
}

/// Successful attach outcome. The `replay` carries `end_seq`
/// which the coordinator reads for `Attached.last_seq` — keeping
/// it in one place avoids the redundant-field maintenance trap
/// that code-quality review flagged on the pre-round-1 design.
struct AttachOutcome {
    new_state: AttachedState,
    replay: ReplaySlice,
}

impl AttachOutcome {
    /// Pane's `total_written` at attach time, echoed in
    /// `Attached.last_seq`. Derived from whichever variant
    /// `replay` is — every variant carries the end-of-stream
    /// seq.
    fn last_seq(&self) -> u64 {
        match &self.replay {
            ReplaySlice::Fresh { end_seq } => *end_seq,
            ReplaySlice::InRange { end_seq, .. } => *end_seq,
            ReplaySlice::UpToDate { end_seq } => *end_seq,
            ReplaySlice::Gap { end_seq, .. } => *end_seq,
            // Future never reaches AttachOutcome — try_attach
            // rejects it before constructing one. The
            // exhaustive match is for type-system
            // completeness; the value doesn't matter.
            ReplaySlice::Future => 0,
        }
    }
}

async fn try_attach(
    sessions: &crate::session::SessionManager,
    state: &AppState,
    session: &str,
    cols: u16,
    rows: u16,
    resume_from_seq: Option<u64>,
) -> Result<AttachOutcome, AttachFailure> {
    let to_failure = |err: crate::session::SessionError| {
        let (code, message) = classify_session_error(&err);
        AttachFailure {
            code,
            message,
            err: err.to_string(),
        }
    };
    sessions
        .create_session(session, cols, rows)
        .await
        .map_err(to_failure)?;
    let pane_id = sessions
        .query_default_pane(session)
        .await
        .map_err(to_failure)?;

    match resume_from_seq {
        None => {
            // Fresh attach. No peek needed — the client isn't
            // claiming any prior state, so we can't reject it.
            let (rx, subscriber_id, baseline) = state
                .output_router
                .subscribe(pane_id)
                .map_err(to_subscribe_failure)?;
            Ok(AttachOutcome {
                replay: ReplaySlice::Fresh { end_seq: baseline },
                new_state: AttachedState {
                    session: session.to_string(),
                    pane_id,
                    subscriber_id,
                    output_rx: rx,
                    last_seen_seq: baseline,
                    coalescer: Coalescer::new(),
                    last_output_at: None,
                    pending_resize: None,
                },
            })
        }
        Some(after_seq) => {
            // PEEK first so we can reject a bogus resume-seq
            // WITHOUT displacing any prior subscriber. Two
            // reviews flagged the prior "subscribe-first,
            // check-after" version: a version-skew client
            // claiming a future-seq kicked innocent clients on
            // its way to being rejected, and then the cleanup
            // `unsubscribe` wiped the pane's ring. Peek-then-
            // commit closes both bugs.
            match state.output_router.peek_resume(pane_id, after_seq) {
                ReplaySlice::Future => {
                    // Future from peek could mean either:
                    // (a) the pane has real output and the
                    //     client's seq is beyond it (true
                    //     protocol violation — reject), OR
                    // (b) the pane is empty (total_written==0)
                    //     and the client is holding a seq from
                    //     a previous server instance — treat
                    //     kindly as a server-restart reconnect,
                    //     send a Gap-from-0 so the client
                    //     clears its stale terminal and
                    //     starts fresh.
                    //
                    // Disambiguate by checking the pane's
                    // actual total_written via peek_resume(0).
                    // Empty pane → UpToDate { end_seq: 0 } →
                    // restart case; non-empty → peek would
                    // return InRange/Gap/UpToDate for 0, which
                    // means (a): client really is claiming a
                    // seq beyond existing output.
                    let zero_peek = state.output_router.peek_resume(pane_id, 0);
                    if matches!(zero_peek, ReplaySlice::UpToDate { end_seq: 0 }) {
                        // Restart case: commit as Gap-from-0
                        // with empty data. Client clears its
                        // terminal; fresh live output follows
                        // as normal.
                        let (rx, subscriber_id, _baseline) = state
                            .output_router
                            .subscribe(pane_id)
                            .map_err(to_subscribe_failure)?;
                        Ok(AttachOutcome {
                            replay: ReplaySlice::Gap {
                                available_from_seq: 0,
                                data: Vec::new(),
                                end_seq: 0,
                            },
                            new_state: AttachedState {
                                session: session.to_string(),
                                pane_id,
                                subscriber_id,
                                output_rx: rx,
                                last_seen_seq: 0,
                                coalescer: Coalescer::new(),
                                last_output_at: None,
                                pending_resize: None,
                            },
                        })
                    } else {
                        // Real future-seq claim: reject without
                        // touching the subscriber.
                        Err(AttachFailure {
                            code: error_code::INVALID_RESUME,
                            message: "resume_from_seq is beyond server's output counter"
                                .into(),
                            err: format!(
                                "client resume seq {after_seq} > pane total_written for pane {pane_id}"
                            ),
                        })
                    }
                }
                _peek => {
                    // Any non-Future peek is safe to commit.
                    // Subscribe-with-resume does the same work
                    // under the router lock, so the replay we
                    // actually return is authoritative (no
                    // dispatch slipped between peek and commit
                    // because we re-read under the lock).
                    let (rx, subscriber_id, replay) = state
                        .output_router
                        .subscribe_with_resume(pane_id, after_seq)
                        .map_err(to_subscribe_failure)?;
                    // Paranoid second Future check — defensive
                    // against a pane being evicted between
                    // peek and commit. Can't happen in 9g/9h
                    // yet (no live eviction path), but the
                    // subscribe already succeeded so we must
                    // clean up this subscriber before rejecting.
                    if matches!(replay, ReplaySlice::Future) {
                        state.output_router.clear_subscriber(pane_id, subscriber_id);
                        return Err(AttachFailure {
                            code: error_code::INVALID_RESUME,
                            message: "resume_from_seq is beyond server's output counter"
                                .into(),
                            err: format!(
                                "pane {pane_id} raced between peek and commit (evicted?)"
                            ),
                        });
                    }
                    let last_seq = match &replay {
                        ReplaySlice::Fresh { end_seq } => *end_seq,
                        ReplaySlice::InRange { end_seq, .. } => *end_seq,
                        ReplaySlice::UpToDate { end_seq } => *end_seq,
                        ReplaySlice::Gap { end_seq, .. } => *end_seq,
                        ReplaySlice::Future => unreachable!("just checked above"),
                    };
                    Ok(AttachOutcome {
                        replay,
                        new_state: AttachedState {
                            session: session.to_string(),
                            pane_id,
                            subscriber_id,
                            output_rx: rx,
                            last_seen_seq: last_seq,
                            coalescer: Coalescer::new(),
                            last_output_at: None,
                            pending_resize: None,
                        },
                    })
                }
            }
        }
    }
}

/// Emit `OutputGap` + replay `Output` frames between `Attached`
/// and the first live flush. Returns `Err(())` if the transport
/// is already gone — caller breaks the serve loop.
async fn send_replay(
    handle: &TransportHandle,
    replay: ReplaySlice,
) -> Result<(), ()> {
    match replay {
        // Nothing to emit — fresh attach, up-to-date reconnect,
        // or defensive Future (rejected earlier; shouldn't
        // reach here).
        ReplaySlice::Fresh { .. }
        | ReplaySlice::UpToDate { .. }
        | ReplaySlice::Future => Ok(()),
        ReplaySlice::InRange { data, end_seq } => {
            if data.is_empty() {
                return Ok(());
            }
            handle
                .send(ServerMessage::Output {
                    data,
                    seq: end_seq,
                })
                .await
                .map_err(|_| ())
        }
        ReplaySlice::Gap {
            available_from_seq,
            data,
            end_seq,
        } => {
            // Order matters: OutputGap first so the client
            // clears its terminal before applying the replay
            // bytes. If either send fails, caller closes.
            handle
                .send(ServerMessage::OutputGap {
                    available_from_seq,
                    last_seq: end_seq,
                })
                .await
                .map_err(|_| ())?;
            if data.is_empty() {
                return Ok(());
            }
            handle
                .send(ServerMessage::Output {
                    data,
                    seq: end_seq,
                })
                .await
                .map_err(|_| ())
        }
    }
}

/// Get the `SessionManager` out of `AppState`, panicking if it's
/// `None`. Safe ONLY for call sites that have already verified
/// we're in `Phase::Attached` — the attach path required
/// `sessions` to be `Some` to reach `Attached` at all, and the
/// field never transitions back to `None`. Extracted from three
/// repeated `.expect(...)` sites in the main loop.
fn require_sessions(state: &AppState) -> &crate::session::SessionManager {
    state
        .sessions
        .as_deref()
        .expect("Attached phase implies sessions is Some")
}

/// Decide whether a revocation event should tear down this
/// connection. `credential_id` is the one this transport is bound
/// to (from auth).
///
/// Every close path uses the `CONNECTION_TERMINATED` wire code so
/// the client can't distinguish "revoked" from "lagged" — that
/// distinction leaks revocation state to whoever holds the socket.
/// The actual cause is emitted as a structured tracing field, so
/// operators can tell from logs which branch fired.
fn handle_revoke(
    revoke: Result<RevocationEvent, RecvError>,
    bound_credential: Option<&str>,
) -> Action {
    match revoke {
        Ok(event) => match bound_credential {
            Some(mine) if mine == event.credential_id => {
                tracing::info!(
                    credential_id = %event.credential_id,
                    cause = "credential_revoked",
                    "session connection terminating"
                );
                Action::Close {
                    code: error_code::CONNECTION_TERMINATED,
                    message: "connection terminated".into(),
                }
            }
            _ => Action::Continue,
        },
        Err(RecvError::Lagged(n)) => {
            tracing::warn!(
                lagged_events = n,
                cause = "broadcast_lagged",
                "session connection terminating (conservative close)"
            );
            Action::Close {
                code: error_code::CONNECTION_TERMINATED,
                message: "connection terminated".into(),
            }
        }
        Err(RecvError::Closed) => Action::Exit,
    }
}

/// Send an `Error` message, then return — the caller drops the
/// transport and the WS pump closes the socket. Best-effort: if
/// the transport is already gone, the send fails and we swallow.
async fn send_error_and_close(handle: &TransportHandle, code: &str, message: String) {
    let _ = handle
        .send(ServerMessage::Error {
            code: code.into(),
            message,
        })
        .await;
}

/// Map a router `SubscribeError` into a handler `AttachFailure`
/// with the matching wire error code. Only one variant today
/// (`Oversubscribed`); kept in a dedicated helper so adding
/// future subscribe error variants doesn't scatter mapping
/// logic across the attach arms.
fn to_subscribe_failure(err: SubscribeError) -> AttachFailure {
    match err {
        SubscribeError::Oversubscribed {
            pane_id,
            active,
            max,
        } => AttachFailure {
            code: error_code::SESSION_OVERSUBSCRIBED,
            message: "too many devices attached to this session".into(),
            err: format!(
                "pane {pane_id} has {active}/{max} subscribers"
            ),
        },
    }
}

fn classify_session_error(err: &crate::session::SessionError) -> (&'static str, String) {
    use crate::session::SessionError;
    match err {
        SessionError::InvalidName(_) => (
            error_code::INVALID_SESSION,
            "invalid session name".into(),
        ),
        SessionError::TmuxRejected(_) | SessionError::Tmux(_) => (
            error_code::SESSION_ERROR,
            // Do NOT embed raw tmux output in the client message.
            // The `SessionManager` doc calls this out explicitly
            // (socket paths, other session names, internal
            // diagnostics). A generic client-facing string is
            // enough; operators have the tracing field.
            "session operation failed".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    //! State-machine tests. Transport-free and SessionManager-free
    //! where possible; the I/O integration tests for the output/
    //! input/resize paths live alongside their modules
    //! (`output.rs`, `router.rs`, `manager.rs`) because the
    //! integration points are small and directly testable.

    use super::*;

    fn ack_v1() -> ClientMessage {
        ClientMessage::HelloAck {
            protocol_version: PROTOCOL_VERSION.into(),
        }
    }

    // ---------- Phase machine (unchanged from slice 9e) ----------

    #[test]
    fn hello_ack_advances_phase() {
        let mut phase = Phase::AwaitingHelloAck;
        let action = step(&mut phase, ack_v1());
        assert_eq!(action, Action::AdvanceToAwaitingAttach);
        assert_eq!(phase, Phase::AwaitingAttach);
    }

    #[test]
    fn mismatched_protocol_version_closes() {
        let mut phase = Phase::AwaitingHelloAck;
        let action = step(
            &mut phase,
            ClientMessage::HelloAck {
                protocol_version: "katulong/999.0".into(),
            },
        );
        match action {
            Action::Close { code, .. } => {
                assert_eq!(code, error_code::PROTOCOL_VERSION_MISMATCH);
            }
            other => panic!("expected close, got {other:?}"),
        }
        assert_eq!(phase, Phase::AwaitingHelloAck);
    }

    #[test]
    fn input_before_attached_is_protocol_violation() {
        let mut phase = Phase::AwaitingAttach;
        let action = step(
            &mut phase,
            ClientMessage::Input {
                data: vec![0x61, 0x62, 0x63],
            },
        );
        match action {
            Action::Close { code, message } => {
                assert_eq!(code, error_code::UNEXPECTED_MESSAGE);
                assert!(message.contains("input"), "message: {message}");
                assert!(message.contains("awaiting_attach"), "message: {message}");
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn resize_before_attached_is_protocol_violation() {
        let mut phase = Phase::AwaitingAttach;
        let action = step(
            &mut phase,
            ClientMessage::Resize {
                cols: 80,
                rows: 24,
            },
        );
        match action {
            Action::Close { code, .. } => assert_eq!(code, error_code::UNEXPECTED_MESSAGE),
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn hello_ack_in_attached_phase_is_protocol_violation() {
        let mut phase = Phase::Attached;
        let action = step(&mut phase, ack_v1());
        match action {
            Action::Close { code, .. } => assert_eq!(code, error_code::UNEXPECTED_MESSAGE),
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn ping_is_allowed_in_every_phase() {
        for mut phase in [
            Phase::AwaitingHelloAck,
            Phase::AwaitingAttach,
            Phase::Attached,
        ] {
            let before = phase.clone();
            let action = step(&mut phase, ClientMessage::Ping { nonce: 7 });
            assert_eq!(action, Action::SendPong(7));
            assert_eq!(phase, before, "ping must not change phase in {before:?}");
        }
    }

    #[test]
    fn attach_in_await_attach_issues_do_attach() {
        let mut phase = Phase::AwaitingAttach;
        let action = step(
            &mut phase,
            ClientMessage::Attach {
                session: "main".into(),
                cols: 120,
                rows: 40,
                resume_from_seq: None,
            },
        );
        assert_eq!(
            action,
            Action::DoAttach {
                session: "main".into(),
                cols: 120,
                rows: 40,
                resume_from_seq: None,
            }
        );
        assert_eq!(
            phase,
            Phase::AwaitingAttach,
            "step does not advance to Attached — the coordinator does \
             that only after SessionManager::create_session succeeds"
        );
    }

    #[test]
    fn attach_with_resume_carries_seq_to_action() {
        // Forward-safety: if the pattern match on Attach ever
        // loses the resume_from_seq field, the coordinator would
        // silently default to fresh-attach for every reconnect.
        let mut phase = Phase::AwaitingAttach;
        let action = step(
            &mut phase,
            ClientMessage::Attach {
                session: "main".into(),
                cols: 80,
                rows: 24,
                resume_from_seq: Some(42),
            },
        );
        assert_eq!(
            action,
            Action::DoAttach {
                session: "main".into(),
                cols: 80,
                rows: 24,
                resume_from_seq: Some(42),
            }
        );
    }

    #[test]
    fn attach_in_wrong_phase_is_violation() {
        let mut phase = Phase::AwaitingHelloAck;
        let action = step(
            &mut phase,
            ClientMessage::Attach {
                session: "main".into(),
                cols: 80,
                rows: 24,
                resume_from_seq: None,
            },
        );
        match action {
            Action::Close { code, .. } => assert_eq!(code, error_code::UNEXPECTED_MESSAGE),
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn input_after_attached_issues_forward() {
        let mut phase = Phase::Attached;
        let action = step(
            &mut phase,
            ClientMessage::Input {
                data: vec![0x41, 0x42],
            },
        );
        assert_eq!(
            action,
            Action::ForwardInput {
                data: vec![0x41, 0x42],
            }
        );
    }

    #[test]
    fn resize_after_attached_issues_queue_resize() {
        let mut phase = Phase::Attached;
        let action = step(
            &mut phase,
            ClientMessage::Resize {
                cols: 100,
                rows: 30,
            },
        );
        assert_eq!(
            action,
            Action::QueueResize {
                cols: 100,
                rows: 30,
            }
        );
    }

    #[test]
    fn protocol_version_error_truncates_control_chars() {
        let mut phase = Phase::AwaitingHelloAck;
        let crafted = "evil\r\n[WARN] forged_line";
        let action = step(
            &mut phase,
            ClientMessage::HelloAck {
                protocol_version: crafted.into(),
            },
        );
        match action {
            Action::Close { message, .. } => {
                assert!(
                    !message.contains('\r') && !message.contains('\n'),
                    "log-bound error message must strip control chars; got {message:?}"
                );
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    // ---------- Revocation ----------

    #[test]
    fn revoke_matching_credential_closes_with_terminated_code() {
        let event = RevocationEvent {
            credential_id: "cred-1".into(),
        };
        let action = handle_revoke(Ok(event), Some("cred-1"));
        match action {
            Action::Close { code, .. } => assert_eq!(code, error_code::CONNECTION_TERMINATED),
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn revoke_other_credential_continues() {
        let event = RevocationEvent {
            credential_id: "other-cred".into(),
        };
        assert_eq!(handle_revoke(Ok(event), Some("cred-1")), Action::Continue);
    }

    #[test]
    fn revoke_when_localhost_bound_continues() {
        let event = RevocationEvent {
            credential_id: "cred-1".into(),
        };
        assert_eq!(handle_revoke(Ok(event), None), Action::Continue);
    }

    #[test]
    fn revoke_lagged_is_conservative_close_with_terminated_code() {
        let action = handle_revoke(Err(RecvError::Lagged(3)), Some("cred-1"));
        match action {
            Action::Close { code, .. } => assert_eq!(code, error_code::CONNECTION_TERMINATED),
            other => panic!("expected close on lagged, got {other:?}"),
        }
    }

    #[test]
    fn revoke_publisher_closed_exits_silently() {
        assert_eq!(
            handle_revoke(Err(RecvError::Closed), Some("cred-1")),
            Action::Exit,
        );
    }

    #[test]
    fn error_codes_are_distinct() {
        let all = [
            error_code::PROTOCOL_VERSION_MISMATCH,
            error_code::UNEXPECTED_MESSAGE,
            error_code::INVALID_SESSION,
            error_code::SESSION_ERROR,
            error_code::NO_SESSION_MANAGER,
            error_code::HANDSHAKE_TIMEOUT,
            error_code::INVALID_RESUME,
            error_code::SESSION_OVERSUBSCRIBED,
            error_code::CONNECTION_TERMINATED,
        ];
        let set: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(set.len(), all.len(), "duplicate error code: {all:?}");
    }

    // ---------- Resize gate deadline math (pure, no runtime) ----------

    fn attached_state_for_gate_tests() -> AttachedState {
        // Build a minimal AttachedState by hand — output_rx +
        // subscriber_id are required by the struct but the
        // gate-math helpers don't touch them.
        let (_tx, rx) = mpsc::channel(1);
        AttachedState {
            session: "s".into(),
            pane_id: 0,
            subscriber_id: SubscriberId::testing(0),
            output_rx: rx,
            last_seen_seq: 0,
            coalescer: Coalescer::new(),
            last_output_at: None,
            pending_resize: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn resize_deadline_none_when_no_pending() {
        let a = attached_state_for_gate_tests();
        assert_eq!(a.resize_deadline(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn resize_deadline_immediate_when_no_prior_output() {
        // A pending resize with no prior output: idle-target ==
        // queued_at, cap-target == queued_at + 500ms. min is
        // queued_at (in the past by the time we check, in real
        // time). Deadline is "already elapsed", so the resize
        // flushes on the very next select iteration.
        let mut a = attached_state_for_gate_tests();
        let now = Instant::now();
        a.pending_resize = Some(PendingResize {
            cols: 80,
            rows: 24,
            queued_at: now,
        });
        assert_eq!(a.resize_deadline(), Some(now));
    }

    #[tokio::test(start_paused = true)]
    async fn resize_deadline_picks_idle_target_under_cap() {
        // Output landed t=0, resize queued at t=10ms. Idle target
        // is t=50ms (output+50). Cap target is t=510ms (queued+500).
        // min = idle, 50ms.
        let mut a = attached_state_for_gate_tests();
        let t0 = Instant::now();
        a.last_output_at = Some(t0);
        tokio::time::advance(Duration::from_millis(10)).await;
        let queued = Instant::now();
        a.pending_resize = Some(PendingResize {
            cols: 80,
            rows: 24,
            queued_at: queued,
        });
        assert_eq!(a.resize_deadline(), Some(t0 + RESIZE_GATE));
    }

    #[tokio::test(start_paused = true)]
    async fn resize_deadline_picks_cap_when_idle_would_starve() {
        // Simulating `tail -f`: output keeps landing, so
        // last_output_at stays recent. If the idle-target
        // perpetually resets further than the cap, cap wins.
        // Here we fake it by setting last_output_at FAR in the
        // future relative to queued_at, so idle-target (far +
        // 50ms) is beyond cap-target (queued + 500ms).
        let mut a = attached_state_for_gate_tests();
        let queued = Instant::now();
        a.pending_resize = Some(PendingResize {
            cols: 80,
            rows: 24,
            queued_at: queued,
        });
        // Pretend an output burst landed 600ms "after" queued
        // (tail -f scenario) — its GATE-offset is beyond the cap.
        a.last_output_at = Some(queued + Duration::from_millis(600));
        assert_eq!(a.resize_deadline(), Some(queued + RESIZE_MAX_DEFER));
    }

    // ---------- Replay & send ordering ----------

    /// In-memory test harness that captures every ServerMessage
    /// the handler sends. Avoids the WS pump plus CBOR
    /// round-tripping — we're testing send-order invariants, not
    /// the transport layer.
    fn capture_handle() -> (TransportHandle, mpsc::Receiver<ServerMessage>) {
        let (outbound_tx, outbound_rx) =
            tokio::sync::mpsc::channel::<ServerMessage>(16);
        let (_inbound_tx, inbound_rx) = tokio::sync::mpsc::channel::<
            Result<ClientMessage, crate::transport::TransportError>,
        >(16);
        let handle = TransportHandle {
            inbound: inbound_rx,
            outbound: outbound_tx,
            kind: crate::transport::TransportKind::WebSocket,
        };
        (handle, outbound_rx)
    }

    #[tokio::test]
    async fn send_replay_fresh_sends_nothing() {
        let (h, mut rx) = capture_handle();
        send_replay(&h, ReplaySlice::Fresh { end_seq: 0 })
            .await
            .expect("fresh is ok");
        assert!(rx.try_recv().is_err(), "Fresh must emit no messages");
    }

    #[tokio::test]
    async fn send_replay_in_range_sends_one_output() {
        let (h, mut rx) = capture_handle();
        send_replay(
            &h,
            ReplaySlice::InRange {
                data: b"resume-bytes".to_vec(),
                end_seq: 12,
            },
        )
        .await
        .unwrap();
        match rx.recv().await.unwrap() {
            ServerMessage::Output { data, seq } => {
                assert_eq!(data, b"resume-bytes");
                assert_eq!(seq, 12);
            }
            other => panic!("expected Output, got {other:?}"),
        }
        assert!(rx.try_recv().is_err(), "only one message expected");
    }

    #[tokio::test]
    async fn send_replay_gap_sends_output_gap_before_output() {
        // Order matters: the client's clear-terminal handler
        // MUST fire before the replay bytes are applied.
        // Regressing this ordering silently re-corrupts the
        // terminal across reconnect gaps — this test is the
        // canary.
        let (h, mut rx) = capture_handle();
        send_replay(
            &h,
            ReplaySlice::Gap {
                available_from_seq: 100,
                data: b"tail-bytes".to_vec(),
                end_seq: 150,
            },
        )
        .await
        .unwrap();
        match rx.recv().await.unwrap() {
            ServerMessage::OutputGap {
                available_from_seq,
                last_seq,
            } => {
                assert_eq!(available_from_seq, 100);
                assert_eq!(last_seq, 150);
            }
            other => panic!("first must be OutputGap, got {other:?}"),
        }
        match rx.recv().await.unwrap() {
            ServerMessage::Output { data, seq } => {
                assert_eq!(data, b"tail-bytes");
                assert_eq!(seq, 150);
            }
            other => panic!("second must be Output, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_replay_gap_with_empty_data_sends_gap_only() {
        let (h, mut rx) = capture_handle();
        send_replay(
            &h,
            ReplaySlice::Gap {
                available_from_seq: 0,
                data: Vec::new(),
                end_seq: 0,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            rx.recv().await.unwrap(),
            ServerMessage::OutputGap { .. }
        ));
        assert!(rx.try_recv().is_err(), "no Output after empty-data Gap");
    }
}
