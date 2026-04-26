//! tmux control-mode client.
//!
//! Owns one long-running `tmux -C -L <socket> attach-session`
//! subprocess and speaks the protocol parsed by `super::parser`.
//! Commands are sent via the subprocess's stdin; replies and
//! asynchronous notifications arrive on stdout.
//!
//! # Why `attach-session`, not `new-session -d`
//!
//! Tmux control mode invoked as `tmux -C new-session -d ...`
//! runs the new-session command and then exits the CM client
//! immediately, because `-d` means detached and the CM has
//! nothing to attach to. This was the original spawn shape and
//! it was silently broken — the CM emitted its initial
//! `%sessions-changed` then `%exit` before any caller could
//! send a follow-up command. Empirically reproduced on tmux
//! 3.6a.
//!
//! The Node katulong implementation uses the proven pattern
//! captured by diwa as commit `a7519f5` ("tmux control mode
//! does not replay screen content on attach"): a CM is spawned
//! with `-C attach-session -t <existing>`. As long as the
//! attached session exists, the CM stays alive and accepts
//! commands.
//!
//! `Tmux::spawn` therefore does TWO things:
//! 1. Synchronously runs `tmux -L <socket> new-session -d -s
//!    <init> -x <cols> -y <rows> "cat"` to start the tmux
//!    server and a "keepalive" session whose only pane runs
//!    `cat`. `cat` blocks on its pty stdin (which never
//!    receives EOF), consuming zero CPU.
//! 2. Spawns the long-lived CM child via
//!    `tmux -L <socket> -C attach-session -t <init>` and hooks
//!    reader/writer/stderr tasks to its pipes.
//!
//! # Visible-output scope: caveat
//!
//! A CM client only receives `%output` notifications for panes
//! in the session it is attached to. The initial keepalive
//! session is the only thing this CM sees output for, and that
//! pane runs `cat` — no useful bytes. Commands like
//! `list-panes -a`, `new-session`, `kill-session`, and global
//! lifecycle events (`%sessions-changed`,
//! `%unlinked-window-close`) DO span every session on the tmux
//! server, so this single CM is sufficient for slice 9i's
//! reconcile path.
//!
//! Routing `%output` for user-facing tiles (each in its own
//! tmux session) requires per-session CM clients — the path
//! the Node implementation took (see Node scars in diwa under
//! "control mode + attach-session"). That's a Path 1 follow-on
//! slice; this slice unblocks command-side integration tests
//! and the slice 9i reconcile model.
//!
//! The client's job splits into three asynchronous pieces:
//!
//! 1. **Reader task** — consumes stdout line by line, parses each
//!    line into a `Notification`, and dispatches:
//!    - `%begin`/`%end`/`%error` + any `Payload` lines between them
//!      → group into a `CommandReply` and hand to the oldest
//!      pending-command oneshot.
//!    - Everything else (`%output`, `%window-close`, ...) → send to
//!      the notification mpsc subscriber.
//! 2. **Writer task** — serializes outgoing command lines and
//!    registers their pending oneshots. Exclusive access to the
//!    stdin half means we don't interleave commands mid-line.
//! 3. **Client API** — `send_command(&str)` pushes to the writer
//!    and awaits the matching reply.
//!
//! # Reader split: functional core, imperative shell
//!
//! The reader is structured as a **pure protocol state machine**
//! plus a **thin imperative driver**. The protocol logic lives in
//! [`step`] — a pure function `(state, parsed, raw) → (state,
//! Vec<Effect>)` whose state space is the [`ProtocolState`] enum
//! and whose outputs are [`Effect`] values. [`run_reader`] is the
//! shell: parse, call `step`, interpret each effect via
//! [`apply_effect`].
//!
//! Why: protocol decisions become exhaustively type-checked (the
//! compiler refuses to build code where a state has no arm), and
//! every transition is unit-testable without spawning subprocesses
//! or holding mutexes. Slices 9l/9m/9n are expected to follow the
//! same template (`enum State`, pure `step`, `Effect` interpreter,
//! thin shell). See memory `feedback_rewrite_fp_direction` for
//! the project-wide policy.
//!
//! # Dedicated tmux socket
//!
//! Every tmux invocation passes `-L <socket_name>` (NOT a path;
//! tmux namespaces its socket dir under `/tmp/tmux-$UID/`).
//! Matches the Node scar `fix(tmux): dedicate LaunchAgent and
//! dev-server tmux to -L katulong socket (#629)`: sharing the
//! default tmux socket with the user's interactive tmux meant a
//! `kill-server` anywhere zapped both. A dedicated socket isolates
//! katulong's tmux state.
//!
//! # Live-tmux tests
//!
//! Integration tests that actually spawn a tmux subprocess are
//! `#[ignore]`-gated so CI without tmux installed still passes;
//! developers run them with `cargo test -- --ignored`.

use super::parser::{parse, Notification, ParseError};
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

/// How long [`Tmux::shutdown`] waits for the CM child to exit
/// cleanly after sending `detach-client` before falling back to
/// SIGKILL. Two seconds matches the Node implementation's
/// watchdog (Node scar `33feed2`) — long enough that a healthy
/// tmux always exits well within budget, short enough that a
/// genuinely stuck process doesn't block server shutdown.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Result of executing one command against tmux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandReply {
    /// `true` if tmux sent `%end`, `false` if it sent `%error`.
    pub ok: bool,
    /// Payload lines between `%begin` and `%end`/`%error`, joined
    /// with `\n`. Empty for commands that produce no output.
    pub output: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TmuxError {
    #[error("io error on tmux stream: {0}")]
    Io(#[from] std::io::Error),
    #[error("tmux exited before responding")]
    Disconnected,
    #[error("parse error: {0}")]
    Parse(#[from] ParseError),
    /// The caller passed a malformed command string (embedded
    /// newline/carriage return, invalid socket name, etc.). Fires
    /// BEFORE any bytes reach tmux; distinct from
    /// `SessionError::TmuxRejected`, which is what you get when
    /// tmux itself refuses a well-formed command.
    #[error("invalid tmux command: {0}")]
    InvalidCommand(String),
}

/// Handle to a running tmux control-mode subprocess.
///
/// Cloning is cheap (`Arc` under the hood) — multiple tasks can
/// call `send_command` concurrently and the writer serializes
/// them. Dropping all handles does NOT kill tmux; call
/// `shutdown()` explicitly if the instance should tear down the
/// server.
#[derive(Clone)]
pub struct Tmux {
    cmd_tx: mpsc::UnboundedSender<OutgoingCommand>,
    /// Held so we can `kill` on explicit shutdown. Behind `Arc<Mutex>`
    /// because tasks may call `shutdown` concurrently; at most one
    /// will actually dispatch the kill.
    child: Arc<Mutex<Option<Child>>>,
    /// The reader/writer tasks' join handles. Same reason: exactly
    /// one shutdown path should await them.
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

/// Sent over the command mpsc. Carries both what to write to
/// tmux's stdin and where to deliver the eventual reply.
struct OutgoingCommand {
    line: String,
    reply: oneshot::Sender<Result<CommandReply, TmuxError>>,
}

/// One-shot sender for a command's reply. The writer pushes one
/// per outgoing command (after writing the command bytes); the
/// reader pops in FIFO order on `%begin` and resolves on
/// `%end`/`%error`. Does NOT carry the command text — the reader
/// has no use for it, and avoiding the extra clone keeps the hot
/// path lean.
type ReplySender = oneshot::Sender<Result<CommandReply, TmuxError>>;

impl Tmux {
    /// Start the tmux server with a detached keepalive session,
    /// then spawn a long-lived `tmux -C attach-session` child as
    /// the control-mode client. See the module-level "Why
    /// `attach-session`, not `new-session -d`" section for the
    /// rationale.
    ///
    /// `socket_name` is validated: alphanumeric + `-_` only, no
    /// leading hyphen, no `/` (which would redirect tmux's socket
    /// file to an attacker-controlled path). Use
    /// `DEDICATED_SOCKET_NAME` for the production convention.
    /// `initial_session` is the keepalive session's name; treat
    /// it as a tmux-internal name, not a user-facing tile name.
    ///
    /// Returns the client handle plus an mpsc receiver for
    /// asynchronous notifications (`%output`, `%window-close`,
    /// ...).
    ///
    /// # Backpressure contract (IMPORTANT)
    ///
    /// The notification receiver is **unbounded**. The caller MUST
    /// drain it continuously — every line of terminal output
    /// produced by any pane tmux controls arrives as a
    /// `Notification::Output` on this channel, which in active
    /// terminal use means hundreds of events per second. An
    /// unconsumed receiver will grow unboundedly and eventually
    /// exhaust memory.
    ///
    /// Slice 9c's terminal handler is the intended consumer and
    /// applies the bounded-ring-buffer + drop-oldest strategy
    /// appropriate for display data. Unit tests and tools that
    /// spawn a `Tmux` without consuming must call `shutdown()`
    /// promptly to prevent buildup.
    pub async fn spawn(
        socket_name: &str,
        initial_session: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Notification>), TmuxError> {
        validate_socket_name(socket_name)?;
        validate_session_name_for_tmux(initial_session)?;

        // Step 1: start the tmux server and a detached keepalive
        // session synchronously. `new-session -d ... cat` creates
        // the session with one pane running `cat`, which blocks
        // on its pty stdin forever (zero CPU). We wait for this
        // command to exit successfully — that's our signal that
        // the tmux server is up and the session exists.
        //
        // We don't keep this subprocess as a Tmux child handle;
        // it's a one-shot "create the server" exec that returns
        // once the work is done.
        let init_status = Command::new("tmux")
            .arg("-L")
            .arg(socket_name)
            .arg("new-session")
            .arg("-d")
            .arg("-s")
            .arg(initial_session)
            .arg("-x")
            .arg(cols.to_string())
            .arg("-y")
            .arg(rows.to_string())
            .arg(KEEPALIVE_PANE_CMD)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await?;
        if !init_status.status.success() {
            let stderr = String::from_utf8_lossy(&init_status.stderr).into_owned();
            return Err(TmuxError::InvalidCommand(format!(
                "tmux new-session failed: {stderr}"
            )));
        }

        // Step 2: spawn the long-lived CM child attached to the
        // keepalive session. If this fails we have to tear down
        // the tmux server we created in step 1 — otherwise a
        // failed spawn leaves the server running with an
        // orphaned keepalive session.
        match Self::cm_attach_raw(socket_name, initial_session).await {
            Ok(handle) => Ok(handle),
            Err(e) => {
                kill_orphan_server(socket_name).await;
                Err(e)
            }
        }
    }

    /// Attach a control-mode client to an EXISTING tmux session.
    /// Pairs with [`Tmux::spawn`] (which creates a new session and
    /// attaches): use `attach` when the session is already
    /// running on the given socket, e.g. when a katulong tile's
    /// session was created earlier and a new WS handler is now
    /// hooking up its own per-tile CM client.
    ///
    /// The session must already exist on `socket_name`. Failures
    /// from this path do NOT touch the tmux server itself —
    /// callers other than `Tmux::spawn` are not the server's
    /// owner.
    pub async fn attach(
        socket_name: &str,
        session: &str,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Notification>), TmuxError> {
        validate_socket_name(socket_name)?;
        validate_session_name_for_tmux(session)?;
        Self::cm_attach_raw(socket_name, session).await
    }

    /// Shared body of [`Tmux::spawn`] and [`Tmux::attach`]: spawn
    /// a `tmux -C attach-session -t <session>` child and hook its
    /// pipes to the reader/writer/stderr-drain tasks. Errors
    /// terminate the child (if it spawned) but do NOT kill the
    /// tmux server — that's `spawn`'s responsibility because only
    /// `spawn` created it.
    async fn cm_attach_raw(
        socket_name: &str,
        session: &str,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Notification>), TmuxError> {
        // `-C attach-session` is the pattern that keeps the CM
        // client alive: the client stays connected as long as the
        // attached session exists. The session's pane behavior
        // determines CM lifetime — for the keepalive session that
        // pane runs `cat` (never exits), for a user-tile session
        // it's the user's shell.
        let mut cmd = Command::new("tmux");
        cmd.arg("-L")
            .arg(socket_name)
            .arg("-C")
            .arg("attach-session")
            .arg("-t")
            .arg(session);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Don't inherit stdin from our process — we're the only
            // writer, and leaking the parent's stdin could drop
            // escape sequences into tmux on terminal resizes.
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(TmuxError::Io)?;
        let stdin = match child.stdin.take() {
            Some(s) => s,
            None => {
                let _ = child.start_kill();
                return Err(TmuxError::Disconnected);
            }
        };
        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                let _ = child.start_kill();
                return Err(TmuxError::Disconnected);
            }
        };
        let stderr = child.stderr.take();

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        let (notif_tx, notif_rx) = mpsc::unbounded_channel::<Notification>();
        let pending: Arc<Mutex<VecDeque<ReplySender>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        let reader_handle =
            tokio::spawn(run_reader(stdout, notif_tx, Arc::clone(&pending)));
        let writer_handle = tokio::spawn(run_writer(stdin, cmd_rx, pending));
        // Drain stderr. If nobody reads, the pipe's 64 KB buffer
        // fills, tmux blocks on write, and the control channel
        // stalls indefinitely. Forward each line to `warn!` so
        // operators see tmux diagnostics in the same log stream
        // as everything else.
        let mut tasks = vec![reader_handle, writer_handle];
        if let Some(stderr) = stderr {
            tasks.push(tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    tracing::warn!(tmux.stderr = %line, "tmux stderr");
                }
            }));
        }

        Ok((
            Self {
                cmd_tx,
                child: Arc::new(Mutex::new(Some(child))),
                tasks: Arc::new(Mutex::new(tasks)),
            },
            notif_rx,
        ))
    }

    /// Construct a `Tmux` handle with no live subprocess behind
    /// it — every `send_command` immediately fails with
    /// `TmuxError::Disconnected`. Exposed so tests in adjacent
    /// modules (router, manager) can build a `SessionManager`
    /// for wiring tests without spawning a real tmux binary.
    #[cfg(test)]
    pub fn dead_for_tests() -> Self {
        let (cmd_tx, _rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        drop(_rx);
        Self {
            cmd_tx,
            child: Arc::new(Mutex::new(None)),
            tasks: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Send one command to tmux and await the reply. `line` must
    /// not contain a newline or carriage return — the writer
    /// appends `\n` itself, and injecting either would let the
    /// caller smuggle a second command past the guard.
    pub async fn send_command(&self, line: &str) -> Result<CommandReply, TmuxError> {
        if line.contains('\n') || line.contains('\r') {
            return Err(TmuxError::InvalidCommand(
                "command contains embedded newline or carriage return".into(),
            ));
        }
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(OutgoingCommand {
                line: line.to_string(),
                reply,
            })
            .map_err(|_| TmuxError::Disconnected)?;
        rx.await.map_err(|_| TmuxError::Disconnected)?
    }

    /// Cleanly tear down this CM client. Idempotent — calling
    /// twice is safe; the second call no-ops.
    ///
    /// # tmux 3.6a UAF avoidance (Node scar `33feed2`)
    ///
    /// tmux 3.6a has a use-after-free in
    /// `control_notify_client_detached` that triggers when a
    /// `tmux -C` child dies abruptly (e.g. SIGTERM/SIGKILL),
    /// causing the tmux server to segfault and take EVERY
    /// session with it. The Node implementation captured this
    /// scar tissue: walk tmux's normal detach path by writing
    /// `detach-client\n` on stdin first, wait for the CM to
    /// close cleanly, then SIGKILL only as a watchdog fallback
    /// if it didn't exit on its own.
    ///
    /// Sequence:
    /// 1. Send `detach-client` via the CM's command channel
    ///    (best-effort — if the channel is already torn down,
    ///    proceed to step 3).
    /// 2. Wait up to [`SHUTDOWN_GRACE`] for the child process
    ///    to exit on its own.
    /// 3. If still alive, SIGKILL as a last resort.
    /// 4. Abort the reader/writer/stderr tasks and await them.
    pub async fn shutdown(&self) {
        // Step 1: ask the CM client to detach in-band. We don't
        // care about the reply — tmux closes the connection
        // immediately after acking the detach, so the oneshot
        // typically resolves with `Disconnected`. The point is
        // that tmux saw the request and walked its normal
        // detach path before the child exits.
        let _ = self.send_command("detach-client").await;

        // Step 2 + 3: drain the child handle. If detach-client
        // worked, `child.wait()` returns quickly. If not (channel
        // dead, tmux misbehaving), the watchdog SIGKILLs.
        if let Some(mut child) = self.child.lock().await.take() {
            match tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await {
                Ok(_) => { /* clean exit */ }
                Err(_) => {
                    // Watchdog tripped — fall back to abrupt
                    // kill. This may still trigger the UAF, but
                    // we tried the clean path first.
                    tracing::warn!(
                        "tmux CM did not exit within {}s of detach-client; SIGKILL fallback",
                        SHUTDOWN_GRACE.as_secs()
                    );
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
        }

        // Step 4: tear down the reader/writer/stderr tasks. They
        // would exit on their own once stdout/stdin close, but
        // aborting + awaiting makes shutdown deterministic.
        let handles = std::mem::take(&mut *self.tasks.lock().await);
        for h in handles {
            h.abort();
            let _ = h.await;
        }
    }
}

/// Default tmux socket name for production deployments. Matches
/// the Node implementation's `-L katulong` convention so a migrated
/// install doesn't collide with the operator's interactive tmux.
/// Staging instances override this via their own per-worktree name
/// (e.g. `stage-rewrite-rust-leptos`) when they spawn `Tmux`.
pub const DEDICATED_SOCKET_NAME: &str = "katulong";

/// Command run in the keepalive session's pane to keep the CM
/// client attached. `cat` blocks on its pty stdin (which never
/// receives EOF), consuming zero CPU and emitting no `%output`.
/// Named so the choice is grep-able from the spawn site, and so
/// any future swap (e.g. to `sleep infinity` or a `tmux set-option
/// remain-on-exit on` no-command session) lands in one place.
const KEEPALIVE_PANE_CMD: &str = "cat";

/// Allowlist validator shared by socket and session names: empty
/// rejected, no leading hyphen (argument-injection guard against
/// tmux's getopt parser), and only `[a-zA-Z0-9_-]` thereafter.
/// Rejecting `/`, `..`, and control chars forecloses the
/// "tmux creates its socket file in an attacker-controlled
/// location" class of bug.
///
/// `kind` ("socket" / "session") feeds the error message so log
/// scanners and operators can tell which validator rejected.
fn validate_tmux_name(kind: &str, name: &str) -> Result<(), TmuxError> {
    let invalid = || TmuxError::InvalidCommand(format!("invalid tmux {kind} name: {name:?}"));
    if name.is_empty() || name.starts_with('-') {
        return Err(invalid());
    }
    for c in name.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(invalid());
        }
    }
    Ok(())
}

/// Validate a tmux socket name. Sockets are chosen at server
/// startup from operator config, not user input — still, a
/// misconfigured staging script could feed something path-like.
fn validate_socket_name(name: &str) -> Result<(), TmuxError> {
    validate_tmux_name("socket", name)
}

/// Validate the `-s` argument of the initial `new-session`.
/// Mirrors `SessionManager::validate_session_name` but lives here
/// so `Tmux::spawn` can reject before any subprocess lifecycle
/// setup happens.
fn validate_session_name_for_tmux(name: &str) -> Result<(), TmuxError> {
    validate_tmux_name("session", name)
}

/// # Reader protocol state machine (pure core)
///
/// The reader's job — parse tmux's CM stdout, group `%begin` /
/// `%end` framing into command replies, and forward async
/// notifications — is a state machine with three discrete
/// states. We model it as `enum ProtocolState` so every
/// transition is captured by the [`step`] function, exhaustively
/// type-checked at compile time, and unit-testable without
/// spawning subprocesses or holding mutexes.
///
/// Side effects ([`Effect`]) are described as values returned
/// from `step`; the imperative shell ([`run_reader`]) executes
/// them. This is the "functional core, imperative shell"
/// pattern: the protocol logic is pure, the IO is a thin loop
/// that calls the pure function and runs its outputs.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ProtocolState {
    /// Initial state immediately after spawn. tmux emits one
    /// orphan `%begin`/`%end` pair at attach time before
    /// processing any user command; while warming we drop those
    /// rather than consume pending command slots. Transitions to
    /// [`ProtocolState::Ready`] on EITHER:
    ///   - the first `%end` / `%error` (handshake closing), OR
    ///   - `%session-changed` (tmux's primary attach-completion
    ///     signal).
    Warming,
    /// Accepting commands. `%begin` pops a pending reply slot
    /// and transitions to [`ProtocolState::InFlight`].
    Ready,
    /// `%begin` received; accumulating payload lines until
    /// `%end` or `%error` closes the reply. The `payload` Vec
    /// holds the raw lines (UTF-8) collected so far, in order.
    ///
    /// TODO(payload-cap): unbounded under a misbehaving tmux
    /// that emits `%begin` then floods stdout without `%end`.
    /// Local-only DoS (CM stdout is not network-reachable).
    /// Add a soft cap (e.g. 64K lines / 64 MiB) and
    /// `CompleteReply { ok: false, ... }` on overflow before
    /// Path 1 widens the trust surface.
    InFlight { payload: Vec<String> },
}

/// Side effects the [`step`] function describes. The imperative
/// shell interprets each variant against its real resources
/// (oneshot senders, mpsc channels, the pending FIFO).
#[derive(Debug, PartialEq, Eq)]
enum Effect {
    /// Forward an async notification to the consumer's channel.
    EmitNotif(Notification),
    /// Pop the oldest entry from the pending FIFO and bind its
    /// oneshot as the active in-flight reply slot. If pending is
    /// empty (stream desync), the shell logs a warn and the
    /// subsequent CompleteReply silently drops.
    BindNextReply,
    /// Resolve the active in-flight reply slot with the given
    /// success bit and accumulated payload. The shell joins the
    /// payload Vec with `\n` and sends the resulting `CommandReply`
    /// on the oneshot.
    CompleteReply { ok: bool, payload: Vec<String> },
    /// Observability tag describing what just happened. The pure
    /// core names the event symbolically; the shell decides how
    /// to surface it (trace level, warn level, formatter). Tests
    /// assert on the variant rather than coupling to log strings.
    Note(StepNote),
}

/// Symbolic observability tags emitted by [`step`]. Each variant
/// names a notable transition or non-action; the shell maps to a
/// tracing call. Adding a variant here requires updating
/// [`apply_effect`]'s `Note` arm — the compiler enforces.
#[derive(Debug, PartialEq, Eq)]
enum StepNote {
    /// Orphan `%begin` arrived during attach warm-up; ignored.
    /// Expected on every CM attach (trace level).
    WarmupOrphanBegin,
    /// First warm-up `%end`/`%error` consumed. State machine
    /// transitioned `Warming → Ready` (trace level).
    WarmupHandshakeClosed,
    /// `%end`/`%error` arrived in Ready with no in-flight reply.
    /// Stream is desynchronized (warn level).
    OrphanEndOutOfSync,
    /// Nested `%begin` while a reply is already in-flight.
    /// Existing in-flight preserved; this is a tmux protocol
    /// error and may indicate FIFO desync downstream
    /// (warn level — see TODO in [`step`]).
    NestedBeginInFlight,
    /// `Payload` line outside any `%begin`/`%end` block;
    /// discarded (trace level).
    OrphanPayloadDiscarded,
}

/// Pure transition function — `(state, parsed_notif, raw_line)
/// → (next_state, effects)`. No IO, no mutation, no async. Every
/// (state, notification) pair has an explicit branch; the
/// compiler enforces exhaustiveness.
///
/// `raw` is the original stdout line (pre-parse), needed because
/// `Notification::Unknown` and lines parsed as `Payload` both
/// represent command output that should be re-accumulated as the
/// raw text — the parsed values strip the leading `%` from
/// `Unknown`, so we can't reconstruct the raw line from the
/// `Notification` alone.
///
/// Security note: tmux wraps every byte from a user pane in a
/// `%output %P data` envelope. A user typing literal text like
/// `%end 0 0 0` into their shell does NOT produce a bare `%end`
/// line on the CM stdout — it arrives as `%output %N %end 0 0 0`,
/// which parses as `Notification::Output` and routes through the
/// EmitNotif branch (any state). The framing remains unforgeable
/// from user input, which keeps the InFlight termination branches
/// (matching `%end` / `%error`) safe even in Path 1's
/// per-session CM model.
fn step(
    state: ProtocolState,
    parsed: Notification,
    raw: String,
) -> (ProtocolState, Vec<Effect>) {
    use Effect::*;
    use Notification as N;
    use ProtocolState::*;

    match (state, parsed) {
        // ===== Warming → Ready =====
        // Two paths to flip ready:
        //   (a) the first orphan `%end` / `%error` (the warm-up
        //       handshake pair closing).
        //   (b) `%session-changed` (tmux's primary signal).
        // Both kept for belt-and-suspenders against tmux versions
        // that might omit or reorder the signals.
        (Warming, N::Begin { .. }) => (
            Warming,
            vec![Note(StepNote::WarmupOrphanBegin)],
        ),
        (Warming, N::End { .. } | N::Error { .. }) => (
            Ready,
            vec![Note(StepNote::WarmupHandshakeClosed)],
        ),
        (Warming, n @ N::SessionChanged { .. }) => (Ready, vec![EmitNotif(n)]),

        // ===== Ready: framing =====
        (Ready, N::Begin { .. }) => (
            InFlight { payload: Vec::new() },
            vec![BindNextReply],
        ),
        (Ready, N::End { .. } | N::Error { .. }) => (
            Ready,
            vec![Note(StepNote::OrphanEndOutOfSync)],
        ),

        // ===== InFlight: payload accumulation =====
        // Both `Payload` (line didn't start with `%`) and
        // `Unknown` (line started with `%` but isn't a known
        // keyword — the `%1` from `list-panes -F '#{pane_id}'`
        // case) get pushed as the raw line. The parser strips
        // the `%` from Unknown, so we use `raw` to preserve the
        // original byte sequence.
        (InFlight { mut payload }, N::Payload(_) | N::Unknown { .. }) => {
            payload.push(raw);
            (InFlight { payload }, vec![])
        }
        (InFlight { payload }, N::End { .. }) => (
            Ready,
            vec![CompleteReply { ok: true, payload }],
        ),
        (InFlight { payload }, N::Error { .. }) => (
            Ready,
            vec![CompleteReply { ok: false, payload }],
        ),
        // TODO(nested-begin-fifo-desync): correctness reviewer
        // on PR #654 noted that ignoring a nested %begin without
        // also draining a pending FIFO entry can leave the FIFO
        // permanently shifted by one — the spurious pending slot
        // gets matched to the NEXT real command, and every
        // subsequent reply is misrouted. The clean fix is a new
        // effect (e.g. `FailNextPending(reason)`) that resolves
        // the spurious oneshot with a protocol-error before the
        // shell continues. Trigger requires tmux to send nested
        // %begin which is a tmux protocol error itself, so the
        // current behavior is "no worse than today's flag-based
        // version." Address before Path 1 widens concurrent
        // command load.
        (state @ InFlight { .. }, N::Begin { .. }) => (
            state,
            vec![Note(StepNote::NestedBeginInFlight)],
        ),

        // ===== Payload outside InFlight: discard =====
        (state @ (Warming | Ready), N::Payload(_)) => (
            state,
            vec![Note(StepNote::OrphanPayloadDiscarded)],
        ),

        // ===== Async notifications: always emit =====
        // Lifecycle/async notifs route to the notification
        // channel regardless of state. Today this catch-all
        // covers: `Output`, `WindowAdd`, `WindowClose`,
        // `WindowRenamed`, `UnlinkedWindowClose`, `SessionChanged`
        // (in Ready/InFlight; Warming has its own arm),
        // `SessionRenamed`, `SessionsChanged`, `Exit`, and
        // `Unknown` outside InFlight. Folding any of these into
        // an in-flight reply's payload would silently break the
        // dispatcher's reconcile path under Path 1's per-session
        // CM model where lifecycle events from one session can
        // interleave with another session's command reply. If a
        // future `Notification` variant has framing semantics
        // (like `Begin`/`End`/`Payload`), it needs an explicit
        // arm above — the catch-all is for genuinely
        // asynchronous events only.
        (state, n) => (state, vec![EmitNotif(n)]),
    }
}

/// Best-effort tear-down of a tmux server we just created in
/// `Tmux::spawn`'s step 1 but failed to attach to in step 2.
/// Without this, a failed spawn leaves the server running and
/// the next `Tmux::spawn` against the same socket hits
/// `new-session: session already exists`. Invoked from spawn's
/// error paths only — never on the happy path.
async fn kill_orphan_server(socket_name: &str) {
    let _ = Command::new("tmux")
        .arg("-L")
        .arg(socket_name)
        .arg("kill-server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await;
}

/// Imperative shell driving the pure [`step`] state machine.
/// Reads stdout lines, calls `step` for each, and interprets the
/// returned [`Effect`]s against the real resources (oneshot
/// senders held in `current_reply`, the `pending` FIFO, the
/// notification channel).
///
/// The shell holds nothing the state machine could own:
/// `current_reply` is just the oneshot sender for the active
/// in-flight reply (the moved-once channel handle the pure core
/// can't carry through a `Vec<Effect>` without consuming it
/// every step).
async fn run_reader(
    stdout: ChildStdout,
    notifications: mpsc::UnboundedSender<Notification>,
    pending: Arc<Mutex<VecDeque<ReplySender>>>,
) {
    let mut reader = BufReader::new(stdout).lines();
    let mut state = ProtocolState::Warming;
    let mut current_reply: Option<ReplySender> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        let parsed = match parse(&line) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error = %e, line = %line, "tmux parse error; dropping line");
                continue;
            }
        };
        let (next_state, effects) = step(state, parsed, line);
        state = next_state;
        for effect in effects {
            apply_effect(effect, &mut current_reply, &pending, &notifications).await;
        }
    }

    // Stream closed. Fail every pending command with Disconnected.
    let mut pending = pending.lock().await;
    while let Some(reply) = pending.pop_front() {
        let _ = reply.send(Err(TmuxError::Disconnected));
    }
    if let Some(reply) = current_reply.take() {
        let _ = reply.send(Err(TmuxError::Disconnected));
    }
}

/// Execute one [`Effect`] against the shell's mutable resources.
/// Each variant maps to a small, well-defined IO operation.
async fn apply_effect(
    effect: Effect,
    current_reply: &mut Option<ReplySender>,
    pending: &Arc<Mutex<VecDeque<ReplySender>>>,
    notifications: &mpsc::UnboundedSender<Notification>,
) {
    match effect {
        Effect::EmitNotif(n) => {
            // Drop on the floor if no one's listening — that's
            // the mpsc semantics; the consumer is responsible
            // for keeping up.
            let _ = notifications.send(n);
        }
        Effect::BindNextReply => {
            if let Some(reply) = pending.lock().await.pop_front() {
                *current_reply = Some(reply);
            } else {
                tracing::warn!(
                    "tmux %begin with no pending command — stream out of sync; discarding reply"
                );
                *current_reply = None;
            }
        }
        Effect::CompleteReply { ok, payload } => {
            if let Some(reply) = current_reply.take() {
                let r = CommandReply {
                    ok,
                    output: payload.join("\n"),
                };
                let _ = reply.send(Ok(r));
            }
            // No active reply slot means the corresponding
            // BindNextReply hit an empty pending queue (already
            // logged). Silently dropping is the right behavior
            // here — the warning came at bind time.
        }
        Effect::Note(note) => apply_note(note),
    }
}

/// Map a [`StepNote`] observability tag to a tracing call.
/// Centralizing this here keeps the pure core ([`step`])
/// agnostic to log levels and message formatting; future log
/// volume tuning happens in one place.
fn apply_note(note: StepNote) {
    match note {
        StepNote::WarmupOrphanBegin => {
            tracing::trace!("orphan %begin during attach warm-up; ignored")
        }
        StepNote::WarmupHandshakeClosed => {
            tracing::trace!("warm-up handshake closed; protocol ready")
        }
        StepNote::OrphanEndOutOfSync => {
            tracing::warn!("tmux %end/%error with no open command; stream out of sync")
        }
        StepNote::NestedBeginInFlight => {
            tracing::warn!("nested %begin while a reply is in-flight; protocol error")
        }
        StepNote::OrphanPayloadDiscarded => {
            tracing::trace!("payload line outside %begin/%end; discarded")
        }
    }
}

/// Write one command line (and its trailing newline) to tmux's
/// stdin, flushing afterwards. Returns any I/O error unwrapped so
/// the caller can resolve the pending oneshot with the precise
/// error value.
async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

async fn run_writer(
    mut stdin: ChildStdin,
    mut cmd_rx: mpsc::UnboundedReceiver<OutgoingCommand>,
    pending: Arc<Mutex<VecDeque<ReplySender>>>,
) {
    // Architectural note: the writer is intentionally NOT split
    // into a pure-core + shell pair like the reader is (slice 9k
    // template). Its state space is trivial — there is no
    // multi-state machine to model: receive a command, register
    // its reply slot, write to stdin, loop. No protocol-level
    // branching, no deferred decisions. The FP-core split offers
    // no structural benefit at this size; the imperative loop is
    // the right shape. If the writer ever grows protocol logic
    // (e.g., flow control, batched commands, retry backoff),
    // revisit applying the slice 9k template.
    while let Some(cmd) = cmd_rx.recv().await {
        // Register the pending reply BEFORE writing, so a racing
        // reader that sees `%begin` immediately after the flush
        // already has the oneshot to resolve against.
        //
        // KNOWN GAP: PR #654 security review flagged that under
        // concurrent send_command + a write failure, the
        // pop_back below can peel a different entry than the
        // one we just pushed (if a racing reader has already
        // popped the front). The clean fix is to keep the
        // oneshot in scope until write succeeds, then push, so
        // failures can resolve directly without touching the
        // FIFO. Pre-existing — not introduced by slice 9k.
        // Track for follow-on slice (likely 9l or a writer FP
        // refactor).
        pending.lock().await.push_back(cmd.reply);
        if let Err(e) = write_line(&mut stdin, &cmd.line).await {
            if let Some(reply) = pending.lock().await.pop_back() {
                let _ = reply.send(Err(TmuxError::Io(e)));
            }
            break;
        }
    }
    // Channel closed → no more commands coming. Resolve outstanding
    // pending commands with Disconnected. The reader task will also
    // see the stdin close and do the same, whichever gets there first
    // wins.
    let mut pending = pending.lock().await;
    while let Some(reply) = pending.pop_front() {
        let _ = reply.send(Err(TmuxError::Disconnected));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- Pure protocol state-machine (slice 9k FP core) ----------

    fn n_begin() -> Notification {
        Notification::Begin {
            time: 0,
            num: 0,
            flags: 0,
        }
    }
    fn n_end() -> Notification {
        Notification::End {
            time: 0,
            num: 0,
            flags: 0,
        }
    }
    fn n_error() -> Notification {
        Notification::Error {
            time: 0,
            num: 0,
            flags: 0,
        }
    }
    fn n_session_changed() -> Notification {
        Notification::SessionChanged {
            session_id: 0,
            name: "main".into(),
        }
    }

    #[test]
    fn warming_drops_orphan_begin() {
        // Attach handshake's `%begin` arrives while warming —
        // must not consume a pending reply slot. Stays Warming.
        let (state, effects) = step(ProtocolState::Warming, n_begin(), "%begin 0 0 0".into());
        assert_eq!(state, ProtocolState::Warming);
        assert_eq!(effects, vec![Effect::Note(StepNote::WarmupOrphanBegin)]);
    }

    #[test]
    fn warming_to_ready_on_first_end() {
        // Belt-and-suspenders fallback: if `%session-changed`
        // never arrives, the orphan `%end` flips us ready
        // anyway. Closes the HIGH-severity hang risk reviewers
        // flagged on PR #652.
        let (state, _) = step(ProtocolState::Warming, n_end(), "%end 0 0 0".into());
        assert_eq!(state, ProtocolState::Ready);
    }

    #[test]
    fn warming_to_ready_on_first_error() {
        // tmux versions with quirky startup might emit %error
        // for the orphan handshake. Same fallback behavior.
        let (state, _) = step(ProtocolState::Warming, n_error(), "%error 0 0 0".into());
        assert_eq!(state, ProtocolState::Ready);
    }

    #[test]
    fn warming_to_ready_on_session_changed() {
        // tmux's primary attach-completion signal — flips ready
        // AND emits the notification.
        let (state, effects) = step(
            ProtocolState::Warming,
            n_session_changed(),
            "%session-changed $0 main".into(),
        );
        assert_eq!(state, ProtocolState::Ready);
        assert!(matches!(
            effects.as_slice(),
            [Effect::EmitNotif(Notification::SessionChanged { .. })]
        ));
    }

    #[test]
    fn ready_begins_inflight_and_binds_reply() {
        let (state, effects) = step(ProtocolState::Ready, n_begin(), "%begin 1 1 0".into());
        assert!(matches!(state, ProtocolState::InFlight { .. }));
        if let ProtocolState::InFlight { payload } = state {
            assert!(payload.is_empty());
        }
        assert!(matches!(effects.as_slice(), [Effect::BindNextReply]));
    }

    #[test]
    fn ready_with_orphan_end_is_warning() {
        // %end arriving outside an in-flight reply means the
        // pending FIFO got out of sync. Don't crash — just emit
        // an OrphanEndOutOfSync note (shell logs warn).
        let (state, effects) = step(ProtocolState::Ready, n_end(), "%end 0 0 0".into());
        assert_eq!(state, ProtocolState::Ready);
        assert_eq!(effects, vec![Effect::Note(StepNote::OrphanEndOutOfSync)]);
    }

    #[test]
    fn inflight_payload_accumulates_raw_lines() {
        // Both Payload and Unknown push the RAW line — Unknown
        // strips the leading `%` from the parsed value, so we
        // need the raw text to preserve `list-panes -F` output
        // shapes like `%1`.
        let s0 = ProtocolState::InFlight {
            payload: vec![],
        };
        let (s1, e1) = step(s0, Notification::Payload("plain".into()), "plain".into());
        assert!(e1.is_empty());
        let (s2, e2) = step(
            s1,
            Notification::Unknown {
                keyword: "1".into(),
                rest: "".into(),
            },
            "%1".into(),
        );
        assert!(e2.is_empty());
        if let ProtocolState::InFlight { payload } = s2 {
            assert_eq!(payload, vec!["plain".to_string(), "%1".to_string()]);
        } else {
            panic!("expected InFlight");
        }
    }

    #[test]
    fn inflight_end_completes_with_ok_true() {
        let s0 = ProtocolState::InFlight {
            payload: vec!["%5".into()],
        };
        let (state, effects) = step(s0, n_end(), "%end 0 0 0".into());
        assert_eq!(state, ProtocolState::Ready);
        match effects.as_slice() {
            [Effect::CompleteReply { ok: true, payload }] => {
                assert_eq!(payload, &vec!["%5".to_string()]);
            }
            other => panic!("expected CompleteReply ok=true, got {other:?}"),
        }
    }

    #[test]
    fn inflight_error_completes_with_ok_false() {
        let s0 = ProtocolState::InFlight {
            payload: vec!["err line".into()],
        };
        let (state, effects) = step(s0, n_error(), "%error 0 0 0".into());
        assert_eq!(state, ProtocolState::Ready);
        match effects.as_slice() {
            [Effect::CompleteReply { ok: false, payload }] => {
                assert_eq!(payload, &vec!["err line".to_string()]);
            }
            other => panic!("expected CompleteReply ok=false, got {other:?}"),
        }
    }

    #[test]
    fn inflight_nested_begin_warns_and_holds_state() {
        // tmux shouldn't emit %begin while another reply is
        // in-flight. If it does, log a warn and don't blow away
        // the existing payload.
        let s0 = ProtocolState::InFlight {
            payload: vec!["existing".into()],
        };
        let (state, effects) = step(s0, n_begin(), "%begin 2 2 0".into());
        match state {
            ProtocolState::InFlight { payload } => {
                assert_eq!(payload, vec!["existing".to_string()]);
            }
            other => panic!("expected InFlight to be preserved, got {other:?}"),
        }
        assert_eq!(effects, vec![Effect::Note(StepNote::NestedBeginInFlight)]);
    }

    #[test]
    fn lifecycle_notif_emits_regardless_of_state() {
        // Slice 9k MEDIUM finding from PR #652: lifecycle notifs
        // (%sessions-changed, %window-close, etc.) must always
        // route to the notification channel even mid-reply, so
        // the dispatcher's reconcile path keeps working under
        // Path 1's per-session CMs.
        for state in [
            ProtocolState::Warming,
            ProtocolState::Ready,
            ProtocolState::InFlight { payload: vec![] },
        ] {
            let (_, effects) = step(
                state,
                Notification::SessionsChanged,
                "%sessions-changed".into(),
            );
            assert!(
                matches!(
                    effects.as_slice(),
                    [Effect::EmitNotif(Notification::SessionsChanged)]
                ),
                "SessionsChanged must emit in every state"
            );
        }
    }

    #[test]
    fn window_close_emits_in_flight() {
        // Concrete check for the dispatcher's reconcile triggers
        // arriving mid-reply.
        let s0 = ProtocolState::InFlight {
            payload: vec!["partial".into()],
        };
        let (state, effects) = step(
            s0,
            Notification::WindowClose { window_id: 5 },
            "%window-close @5".into(),
        );
        // State preserved (still in-flight).
        if let ProtocolState::InFlight { payload } = state {
            assert_eq!(payload, vec!["partial".to_string()]);
        } else {
            panic!("expected InFlight preserved");
        }
        // WindowClose forwarded to notif channel.
        assert!(matches!(
            effects.as_slice(),
            [Effect::EmitNotif(Notification::WindowClose { window_id: 5 })]
        ));
    }

    #[test]
    fn payload_outside_inflight_is_discarded() {
        let (state, effects) = step(
            ProtocolState::Ready,
            Notification::Payload("orphan".into()),
            "orphan".into(),
        );
        assert_eq!(state, ProtocolState::Ready);
        assert_eq!(effects, vec![Effect::Note(StepNote::OrphanPayloadDiscarded)]);
    }

    #[tokio::test]
    async fn send_command_before_spawn_fails() {
        // Build a Tmux with a dead channel to exercise the
        // Disconnected path without needing a real tmux binary.
        let (tx, rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        let t = Tmux {
            cmd_tx: tx.clone(),
            child: Arc::new(Mutex::new(None)),
            tasks: Arc::new(Mutex::new(vec![])),
        };
        drop(tx);
        drop(rx);
        let err = t.send_command("list-sessions").await.unwrap_err();
        assert!(matches!(err, TmuxError::Disconnected));
    }

    #[tokio::test]
    async fn embedded_newline_is_rejected_without_hitting_tmux() {
        // The write-a-newline guard must kick in before the mpsc
        // send — otherwise tmux would see a malformed partial
        // command.
        let (tx, _rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        let t = Tmux {
            cmd_tx: tx,
            child: Arc::new(Mutex::new(None)),
            tasks: Arc::new(Mutex::new(vec![])),
        };
        let err = t
            .send_command("list-sessions\nkill-server")
            .await
            .unwrap_err();
        assert!(matches!(err, TmuxError::InvalidCommand(_)));
    }

    #[tokio::test]
    async fn embedded_carriage_return_is_rejected_without_hitting_tmux() {
        // Companion guard: CR is also a command terminator in some
        // parse paths. Reject symmetrically with LF.
        let (tx, _rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        let t = Tmux {
            cmd_tx: tx,
            child: Arc::new(Mutex::new(None)),
            tasks: Arc::new(Mutex::new(vec![])),
        };
        let err = t
            .send_command("list-sessions\rkill-server")
            .await
            .unwrap_err();
        assert!(matches!(err, TmuxError::InvalidCommand(_)));
    }

    #[test]
    fn socket_name_validator_rejects_path_like_and_leading_hyphen() {
        assert!(validate_socket_name("katulong").is_ok());
        assert!(validate_socket_name("stage-rewrite-rust-leptos").is_ok());
        // Path-likes: rejecting `/` and `..` prevents tmux from
        // creating its socket file in an attacker-controlled
        // location if a future caller forwards config values.
        assert!(validate_socket_name("../evil").is_err());
        assert!(validate_socket_name("/tmp/evil").is_err());
        assert!(validate_socket_name("").is_err());
        assert!(validate_socket_name("-flag").is_err());
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn tmux_roundtrip() {
        // Full end-to-end: spawn a tmux control-mode subprocess,
        // issue `list-sessions`, parse the reply, shutdown.
        // Skipped in CI because not every environment has tmux
        // installed, and the test would need a namespace-isolated
        // socket anyway to not collide with developer tmux.
        let socket = format!("katulong-test-{}", std::process::id());
        let (tmux, _notifs) = Tmux::spawn(&socket, "test-session", 80, 24)
            .await
            .expect("spawn should succeed when tmux is available");
        let reply = tmux
            .send_command("list-sessions -F '#{session_name}'")
            .await
            .expect("list-sessions should succeed");
        assert!(reply.ok, "list-sessions should report %end, not %error");
        assert!(
            reply.output.contains("test-session"),
            "expected our spawned session in list-sessions output: {}",
            reply.output
        );
        tmux.shutdown().await;
    }
}
