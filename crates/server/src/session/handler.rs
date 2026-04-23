//! Per-connection session handler.
//!
//! `serve_session` consumes a `TransportHandle` and runs the
//! terminal-session lifecycle against it: protocol handshake,
//! session attach, revocation watch. It is transport-agnostic by
//! construction — see `project_transport_agnostic` in project
//! memory.
//!
//! # Slice 9e scope
//!
//! - Handshake gate: `Hello` (server) → `HelloAck` (client) →
//!   `Attach` (client) → `Attached` (server).
//! - Phase state machine enforces the order. Messages arriving in
//!   the wrong phase trigger a typed `Error` and a clean transport
//!   close, so the client sees "unexpected_message" rather than an
//!   opaque drop.
//! - `Resize` in the `Attached` phase forwards to `SessionManager`;
//!   tmux clamps and issues `refresh-client -C`.
//! - `Input` in the `Attached` phase is accepted and logged. Slice
//!   9f wires the actual tmux write path (and the `Output`
//!   producer) with coalescing.
//! - Revocation watch: a `tokio::select!` over `handle.inbound` and
//!   `state.subscribe_revocations()` closes the transport
//!   immediately when the bound credential is revoked. Localhost
//!   connections aren't bound to a credential and can't be
//!   revoked — they exit only on peer disconnect.
//!
//! # Why a state machine, not "just check in the match"
//!
//! The alternative is per-variant guards like `if !attached {
//! return Err(unexpected) }` scattered through the main loop. That
//! works but makes it easy to forget a guard on a newly-added
//! variant (the future `Output` from an echo-tester, say). The
//! phase enum forces every addition to be placed in a phase, and
//! the unit tests below snap whenever a variant crosses phases
//! without explicit consent.

use crate::log_util::sanitize_for_log;
use crate::revocation::RevocationEvent;
use crate::state::AppState;
use crate::transport::{
    ClientMessage, ServerMessage, TransportHandle, PROTOCOL_VERSION,
};
use tokio::sync::broadcast::error::RecvError;

/// How long we wait between connection upgrade and receiving
/// `HelloAck` before closing. WS-level keepalive keeps the socket
/// alive indefinitely; without this a silent peer can pin a
/// connection forever. Generous enough that a high-latency real
/// client completes well within it; short enough that a scraper
/// probing `/ws` with no cookie (shouldn't happen — auth gates the
/// upgrade) or a half-open connection is reaped promptly.
const HANDSHAKE_TIMEOUT_SECS: u64 = 10;

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
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// Server has sent `Hello`; waiting for the client to ack with
    /// a matching protocol version.
    AwaitingHelloAck,
    /// Protocol version confirmed; waiting for the client to send
    /// `Attach` with a session name and dimensions.
    AwaitingAttach,
    /// Transport is bound to `session`. `Input`/`Resize` are now
    /// valid.
    Attached { session: String },
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
    /// Create/attach the tmux session, then send `Attached` with
    /// the clamped dims.
    DoAttach {
        session: String,
        cols: u16,
        rows: u16,
    },
    /// Forward a resize to the session manager for the currently-
    /// attached session.
    DoResize {
        session: String,
        cols: u16,
        rows: u16,
    },
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
                        // bound on length defensively; don't let an
                        // attacker-chosen version string blow up
                        // log line size
                        sanitize_for_log(&protocol_version, LOG_PROTOCOL_VERSION_MAX_LEN),
                    ),
                }
            }
        }

        (Phase::AwaitingAttach, ClientMessage::Attach { session, cols, rows }) => {
            Action::DoAttach {
                session,
                cols,
                rows,
            }
        }

        (Phase::Attached { session }, ClientMessage::Input { data: _ }) => {
            // Slice 9e accepts Input to exercise the phase-gate but
            // does NOT forward it to the PTY — slice 9f wires the
            // tmux write path with coalescing. Logging at trace
            // keeps the data payload out of default logs entirely.
            tracing::trace!(
                session = %session,
                "session input accepted (forwarding wired in slice 9f)"
            );
            Action::Continue
        }

        (Phase::Attached { session }, ClientMessage::Resize { cols, rows }) => {
            Action::DoResize {
                session,
                cols,
                rows,
            }
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
        Phase::Attached { .. } => "attached",
    }
}

/// Cap on the protocol-version string we echo back in error
/// messages. Far shorter than the Origin cap in `ws.rs` because the
/// version string is a short identifier (`"katulong/0.1"`) — if a
/// client sends something larger, it's either buggy or crafted, and
/// 32 chars is plenty to identify the prefix without letting an
/// attacker flood logs with per-request megabyte payloads.
const LOG_PROTOCOL_VERSION_MAX_LEN: usize = 32;

/// The per-connection consumer loop, parameterised on the
/// transport abstraction. `state` threads session manager + the
/// revocation broadcast; `credential_id` is the credential this
/// transport is bound to (from the auth extractor), or `None` for
/// localhost-exempt connections which can't be revoked.
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
    // See `revocation.rs` subscriber contract: a handler that
    // validates first, then subscribes, misses any revocation that
    // lands between the two calls.
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
    let handshake_deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS);

    loop {
        // The handshake timer only fires while we're still in the
        // handshake phases. Once `Attached`, the timer is disabled
        // (`tokio::select!`'s `biased` + guarded branch handles
        // this explicitly).
        let in_handshake = matches!(
            phase,
            Phase::AwaitingHelloAck | Phase::AwaitingAttach
        );

        let action = tokio::select! {
            biased;

            // Revocation takes precedence over any pending message
            // — a revoked credential's next keystroke should not
            // be processed, not even in the same tick where it
            // arrives alongside the revoke event.
            revoke = revocations.recv() => handle_revoke(revoke, credential_id.as_deref()),

            // Handshake-timer branch: only active while we're
            // still awaiting HelloAck or Attach. Once we've
            // reached `Attached`, this branch is disabled.
            _ = tokio::time::sleep_until(handshake_deadline), if in_handshake => Action::Close {
                code: error_code::HANDSHAKE_TIMEOUT,
                message: "client did not complete handshake in time".into(),
            },

            msg = handle.inbound.recv() => match msg {
                None => Action::Exit,
                Some(Err(err)) => {
                    // Decoder/frame error from the transport. Stay
                    // open — a single bad frame isn't a reason to
                    // kick the user out; the Node scar `9dc7c78`
                    // said validate at the boundary, which the
                    // typed deserialize already does.
                    tracing::warn!(error = %err, "transport frame error; dropping");
                    Action::Continue
                }
                Some(Ok(msg)) => step(&mut phase, msg),
            },
        };

        match action {
            Action::Continue => continue,
            Action::Exit => break,
            Action::SendPong(nonce) => {
                if handle.send(ServerMessage::Pong { nonce }).await.is_err() {
                    break;
                }
            }
            Action::AdvanceToAwaitingAttach => {
                // No server message for this transition — the
                // client already has Hello, and the next expected
                // message from them is Attach. Sending a dedicated
                // "hello acknowledged" would be pure wire bloat.
                continue;
            }
            Action::DoAttach {
                session,
                cols,
                rows,
            } => {
                // Clamp once here, BEFORE calling into
                // SessionManager, so both the session-manager
                // create call and the `Attached` response we send
                // back to the client use identical values. The
                // manager's `create_session` clamps again
                // internally as a defense-in-depth belt — this
                // handler-level clamp is the authoritative
                // "coordinator clamps before dispatch" step.
                // Without this, a 9999-cols request would reach
                // `create_session` unclamped; one careless future
                // refactor that drops the manager's internal
                // clamp would mean tmux sees the raw value. Do it
                // here too so the invariant survives that refactor.
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
                match sessions.create_session(&session, cols, rows).await {
                    Ok(()) => {
                        phase = Phase::Attached {
                            session: session.clone(),
                        };
                        if handle
                            .send(ServerMessage::Attached {
                                session,
                                cols,
                                rows,
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(err) => {
                        let (code, message) = classify_session_error(&err);
                        tracing::warn!(
                            error = %err,
                            code = code,
                            "attach rejected"
                        );
                        send_error_and_close(&handle, code, message).await;
                        break;
                    }
                }
            }
            Action::DoResize {
                session,
                cols,
                rows,
            } => {
                // SAFETY: `sessions` must be `Some` to reach
                // `Attached` phase; the only path to Attached is
                // through a successful create_session above, which
                // requires `state.sessions` to be Some.
                let sessions = state
                    .sessions
                    .as_deref()
                    .expect("Attached phase implies sessions is Some");
                if let Err(err) = sessions.resize_session(&session, cols, rows).await {
                    // Resize failure on an already-attached session
                    // is noisy but not fatal. Log and keep the
                    // transport open; the client will try again on
                    // the next layout event. Do NOT leak raw tmux
                    // output to the client.
                    tracing::warn!(
                        session = %session,
                        error = %err,
                        "resize failed; keeping transport open"
                    );
                }
            }
            Action::Close { code, message } => {
                send_error_and_close(&handle, code, message).await;
                break;
            }
        }
    }

    // Drop the handle. The WS output pump sees the channel close
    // and shuts down the socket gracefully.
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
        // Subscriber fell behind the broadcast buffer. `revocation.rs`
        // subscriber contract: conservative close.
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
        // Publisher dropped. Shouldn't happen in practice
        // (AppState owns it for the server's lifetime), but if it
        // does, we have no more revocation awareness — exit to be
        // safe. `Exit` rather than `Close` because this only fires
        // on process teardown, when there's no value in emitting a
        // protocol-level close frame the runtime is about to tear
        // down anyway.
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
    //! State-machine tests. Transport-free and SessionManager-free:
    //! we feed `step` directly with synthetic messages and assert
    //! on the action it returns. Real-transport end-to-end tests
    //! live under the `transport::websocket` and integration
    //! modules.

    use super::*;

    fn ack_v1() -> ClientMessage {
        ClientMessage::HelloAck {
            protocol_version: PROTOCOL_VERSION.into(),
        }
    }

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
        assert_eq!(
            phase,
            Phase::AwaitingHelloAck,
            "phase should not advance on mismatch"
        );
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
            Action::Close { code, .. } => {
                assert_eq!(code, error_code::UNEXPECTED_MESSAGE);
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn hello_ack_in_attached_phase_is_protocol_violation() {
        // HelloAck is a one-shot; re-sending it later should be
        // treated as out-of-phase. Otherwise a buggy client could
        // hold the connection but never exercise the session.
        let mut phase = Phase::Attached {
            session: "s".into(),
        };
        let action = step(&mut phase, ack_v1());
        match action {
            Action::Close { code, .. } => {
                assert_eq!(code, error_code::UNEXPECTED_MESSAGE);
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn ping_is_allowed_in_every_phase() {
        for mut phase in [
            Phase::AwaitingHelloAck,
            Phase::AwaitingAttach,
            Phase::Attached {
                session: "s".into(),
            },
        ] {
            let before = phase.clone();
            let action = step(&mut phase, ClientMessage::Ping { nonce: 7 });
            assert_eq!(action, Action::SendPong(7));
            assert_eq!(phase, before, "ping must not change phase in {before:?}");
        }
    }

    #[test]
    fn attach_in_await_attach_phase_requests_attach_action() {
        let mut phase = Phase::AwaitingAttach;
        let action = step(
            &mut phase,
            ClientMessage::Attach {
                session: "main".into(),
                cols: 120,
                rows: 40,
            },
        );
        assert_eq!(
            action,
            Action::DoAttach {
                session: "main".into(),
                cols: 120,
                rows: 40,
            }
        );
        // Step does NOT advance to Attached — the coordinator does
        // that only after SessionManager::create_session succeeds.
        // A bad session name that SessionManager rejects must not
        // leave the machine in a silently-attached state.
        assert_eq!(phase, Phase::AwaitingAttach);
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
            },
        );
        match action {
            Action::Close { code, .. } => {
                assert_eq!(code, error_code::UNEXPECTED_MESSAGE);
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn input_after_attached_is_accepted() {
        let mut phase = Phase::Attached {
            session: "main".into(),
        };
        let action = step(
            &mut phase,
            ClientMessage::Input {
                data: vec![0x41],
            },
        );
        assert_eq!(action, Action::Continue);
    }

    #[test]
    fn resize_after_attached_issues_resize_action() {
        let mut phase = Phase::Attached {
            session: "main".into(),
        };
        let action = step(
            &mut phase,
            ClientMessage::Resize {
                cols: 100,
                rows: 30,
            },
        );
        assert_eq!(
            action,
            Action::DoResize {
                session: "main".into(),
                cols: 100,
                rows: 30,
            }
        );
    }

    #[test]
    fn protocol_version_error_truncates_control_chars() {
        // An attacker-controlled version string with embedded
        // control characters must not corrupt operator logs.
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

    #[test]
    fn revoke_matching_credential_closes_with_terminated_code() {
        let event = RevocationEvent {
            credential_id: "cred-1".into(),
        };
        let action = handle_revoke(Ok(event), Some("cred-1"));
        match action {
            Action::Close { code, .. } => {
                assert_eq!(
                    code,
                    error_code::CONNECTION_TERMINATED,
                    "revocation must use the terminated code — distinct from \
                     UNEXPECTED_MESSAGE so clients can tell 'prompt for auth' \
                     apart from 'fix your message'"
                );
            }
            other => panic!("expected close, got {other:?}"),
        }
    }

    #[test]
    fn revoke_other_credential_continues() {
        let event = RevocationEvent {
            credential_id: "other-cred".into(),
        };
        let action = handle_revoke(Ok(event), Some("cred-1"));
        assert_eq!(action, Action::Continue);
    }

    #[test]
    fn revoke_when_localhost_bound_continues() {
        // Localhost connections have no credential binding and
        // can't be revoked. Every incoming revoke event must be a
        // no-op for them.
        let event = RevocationEvent {
            credential_id: "cred-1".into(),
        };
        let action = handle_revoke(Ok(event), None);
        assert_eq!(action, Action::Continue);
    }

    #[test]
    fn revoke_lagged_is_conservative_close_with_terminated_code() {
        let action = handle_revoke(Err(RecvError::Lagged(3)), Some("cred-1"));
        match action {
            Action::Close { code, .. } => {
                assert_eq!(
                    code,
                    error_code::CONNECTION_TERMINATED,
                    "lagged broadcast shares the client-visible code with \
                     revocation — the cause-distinction lives in tracing, \
                     not on the wire"
                );
            }
            other => panic!("expected close on lagged, got {other:?}"),
        }
    }

    #[test]
    fn revoke_publisher_closed_exits_silently() {
        // Publisher dropped means AppState is being torn down
        // — the process is exiting. There's no value in emitting
        // a protocol-level Error frame when the runtime is about
        // to shut down; the `Exit` action drops the handle and
        // lets the transport close with the socket.
        let action = handle_revoke(Err(RecvError::Closed), Some("cred-1"));
        assert_eq!(action, Action::Exit);
    }

    #[test]
    fn error_codes_are_distinct() {
        // Forward-safety: all `error_code::*` constants must
        // carry distinct values. Two same-valued codes would
        // silently collapse two different operator-visible
        // causes into one log line and break clients that key
        // off the specific code. Regressions here are easy to
        // introduce (copy-paste a constant, forget to change the
        // value) and impossible to catch at compile time — hence
        // a dedicated test.
        let all = [
            error_code::PROTOCOL_VERSION_MISMATCH,
            error_code::UNEXPECTED_MESSAGE,
            error_code::INVALID_SESSION,
            error_code::SESSION_ERROR,
            error_code::NO_SESSION_MANAGER,
            error_code::HANDSHAKE_TIMEOUT,
            error_code::CONNECTION_TERMINATED,
        ];
        let set: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(
            set.len(),
            all.len(),
            "duplicate error code in `error_code::*`: {all:?}"
        );
    }
}
