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
//! # Slice 9b scope
//!
//! This slice ships the client type and its protocol handling.
//! Slice 9c wires it into `SessionManager` and exposes it through
//! `AppState`. The integration test that actually spawns tmux is
//! marked `#[ignore]` so CI without tmux installed still passes;
//! developers run it manually with `cargo test -- --ignored
//! tmux_roundtrip`.

use super::parser::{parse, Notification, ParseError};
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

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

/// Entry in the reader's pending-reply queue. The writer pushes
/// one per outgoing command (after successfully writing the bytes
/// to tmux's stdin); the reader pops in FIFO order on `%begin`.
/// Does NOT carry the command text — the reader has no use for
/// it, and avoiding the extra clone keeps the hot path lean.
struct PendingReply {
    reply: oneshot::Sender<Result<CommandReply, TmuxError>>,
}

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
            .arg("cat")
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

        // Step 2: spawn the long-lived CM client attached to the
        // keepalive session. `-C attach-session` is the pattern
        // that keeps the CM alive: the client stays connected as
        // long as the attached session exists. `cat` in the
        // keepalive session never exits, so the CM never gets a
        // `%session-changed`/`%exit` from session death.
        let mut cmd = Command::new("tmux");
        cmd.arg("-L")
            .arg(socket_name)
            .arg("-C")
            .arg("attach-session")
            .arg("-t")
            .arg(initial_session);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Don't inherit stdin from our process — we're the only
            // writer, and leaking the parent's stdin could drop
            // escape sequences into tmux on terminal resizes.
            .kill_on_drop(true);

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().ok_or(TmuxError::Disconnected)?;
        let stdout = child.stdout.take().ok_or(TmuxError::Disconnected)?;
        let stderr = child.stderr.take();

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<OutgoingCommand>();
        let (notif_tx, notif_rx) = mpsc::unbounded_channel::<Notification>();
        let pending: Arc<Mutex<VecDeque<PendingReply>>> =
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

    /// Kill the tmux subprocess and wait for the reader/writer
    /// tasks to finish. Idempotent — calling twice is safe; the
    /// second call no-ops.
    ///
    /// # KNOWN GAP — tmux 3.6a UAF on abrupt CM child kill
    ///
    /// Per Node scar `33feed2`: tmux 3.6a has a use-after-free
    /// in `control_notify_client_detached` that triggers when a
    /// `tmux -C` child dies abruptly (e.g. SIGTERM/SIGKILL),
    /// causing the tmux server to segfault and take EVERY
    /// session with it. The fix walks tmux's normal detach path
    /// by writing `detach-client\n` on stdin first, waiting for
    /// the CM to close cleanly, THEN running `kill-session`.
    /// An unref'd 2-second watchdog SIGKILLs as last resort.
    ///
    /// The current code uses `start_kill` directly. That's the
    /// abrupt path. Today this only fires in test cleanup and
    /// process-shutdown paths where tmux dying is acceptable;
    /// production code never calls `shutdown` on a still-live
    /// instance. Track adding the in-band `detach-client` dance
    /// before this becomes user-visible.
    pub async fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
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

/// Validate a tmux socket name. Same allowlist as session names
/// but enforced here rather than in `SessionManager` because
/// sockets are chosen at server startup from operator config, not
/// user input — still, a misconfigured staging script could feed
/// something path-like. Rejecting `/`, `..`, and control chars now
/// forecloses the "tmux creates its socket file in an
/// attacker-controlled location" class of bug before slice 9c+
/// widens the caller surface.
fn validate_socket_name(name: &str) -> Result<(), TmuxError> {
    if name.is_empty() || name.starts_with('-') {
        return Err(TmuxError::InvalidCommand(format!(
            "invalid tmux socket name: {name:?}"
        )));
    }
    for c in name.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !ok {
            return Err(TmuxError::InvalidCommand(format!(
                "invalid tmux socket name: {name:?}"
            )));
        }
    }
    Ok(())
}

/// Same allowlist, applied to the `-s` argument of the initial
/// `new-session`. Mirrors `SessionManager::validate_session_name`
/// but lives here so `Tmux::spawn` can reject before any
/// subprocess lifecycle setup happens.
fn validate_session_name_for_tmux(name: &str) -> Result<(), TmuxError> {
    if name.is_empty() || name.starts_with('-') {
        return Err(TmuxError::InvalidCommand(format!(
            "invalid tmux session name: {name:?}"
        )));
    }
    for c in name.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !ok {
            return Err(TmuxError::InvalidCommand(format!(
                "invalid tmux session name: {name:?}"
            )));
        }
    }
    Ok(())
}

/// In-flight command reply being accumulated by the reader task.
/// `payload` grows with each `Notification::Payload` seen after
/// `%begin`; when `%end`/`%error` lands, the stored reply channel
/// gets the final `CommandReply`.
struct InFlightReply {
    payload: Vec<String>,
    reply: oneshot::Sender<Result<CommandReply, TmuxError>>,
}

async fn run_reader(
    stdout: ChildStdout,
    notifications: mpsc::UnboundedSender<Notification>,
    pending: Arc<Mutex<VecDeque<PendingReply>>>,
) {
    let mut reader = BufReader::new(stdout).lines();
    // When we see `%begin`, we pop the next pending command's
    // oneshot (already FIFO-ordered) and start collecting payload
    // lines into `current.payload`. `%end` or `%error` resolves
    // the oneshot.
    let mut current: Option<InFlightReply> = None;

    // tmux's CM emits a `%begin <time> <num> 0` / `%end ...` pair
    // at attach time, BEFORE it processes any command we send. If
    // the writer task pushes a pending reply slot during that
    // window, the reader would pop it for the orphan startup pair
    // and resolve our user command with an empty payload. Tmux
    // signals attach completion via `%session-changed`, so we
    // treat any `%begin`/`%end` BEFORE that as orphans and drop
    // them without consuming pending. Once `tmux_ready` flips, the
    // reader behaves normally.
    let mut tmux_ready = false;

    while let Ok(Some(line)) = reader.next_line().await {
        let n = match parse(&line) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error = %e, line = %line, "tmux parse error; dropping line");
                continue;
            }
        };
        // While a command reply is in flight, tmux's `%begin` /
        // `%end` framing wins over the leading-`%` heuristic.
        // Tmux command payloads can themselves start with `%`
        // (e.g. `list-panes -F '#{pane_id}'` returns `%N` per
        // line). The parser treats those as `Notification::
        // Unknown`, but inside a command reply they're payload.
        // Only `%end` and `%error` terminate the in-flight
        // reply; everything else gets pushed as raw payload.
        //
        // Caveat: this means async notifications that arrive
        // between `%begin` and `%end` (uncommon but allowed by
        // tmux's protocol) get folded into the reply payload
        // instead of routing to the notification channel. For
        // katulong's CM-attached-to-keepalive setup, the
        // attached pane is `cat` and emits no `%output`, so
        // interleaving doesn't happen in practice. If it ever
        // does, the right fix is allowlisting specific async
        // notifications even inside reply blocks.
        if current.is_some()
            && !matches!(
                n,
                Notification::End { .. } | Notification::Error { .. }
            )
        {
            if let Some(in_flight) = current.as_mut() {
                in_flight.payload.push(line);
            }
            continue;
        }
        match n {
            Notification::Begin { .. } if !tmux_ready => {
                // Orphan begin from tmux's attach handshake — drop.
                tracing::trace!("tmux %begin during attach warm-up; ignoring");
            }
            Notification::End { .. } | Notification::Error { .. } if !tmux_ready => {
                tracing::trace!("tmux %end/%error during attach warm-up; ignoring");
            }
            Notification::Begin { .. } => {
                // Pop the oldest pending command — tmux replies in
                // the order commands were submitted.
                if let Some(cmd) = pending.lock().await.pop_front() {
                    current = Some(InFlightReply {
                        payload: Vec::new(),
                        reply: cmd.reply,
                    });
                } else {
                    tracing::warn!(
                        "tmux %begin with no pending command — stream out of sync; discarding reply"
                    );
                    current = None;
                }
            }
            Notification::Payload(p) => {
                if let Some(in_flight) = current.as_mut() {
                    in_flight.payload.push(p);
                } else {
                    tracing::trace!(payload = %p, "tmux payload outside begin/end; discarded");
                }
            }
            Notification::End { .. } | Notification::Error { .. } => {
                let is_error = matches!(n, Notification::Error { .. });
                if let Some(in_flight) = current.take() {
                    let r = CommandReply {
                        ok: !is_error,
                        output: in_flight.payload.join("\n"),
                    };
                    let _ = in_flight.reply.send(Ok(r));
                } else {
                    tracing::warn!(
                        "tmux %end/%error with no open command — stream out of sync"
                    );
                }
            }
            other => {
                // tmux signals attach completion via
                // `%session-changed`. Until we see it, the reader
                // is in attach warm-up mode and treats any
                // `%begin`/`%end` as orphans. After it lands, the
                // reader pairs `%begin` to pending command slots
                // normally.
                if matches!(other, Notification::SessionChanged { .. }) {
                    tmux_ready = true;
                }
                // Async notification. Drop on the floor if no one's
                // listening — that's the mpsc semantics and the
                // consumer's responsibility to keep up.
                let _ = notifications.send(other);
            }
        }
    }

    // Stream closed. Fail every pending command with Disconnected.
    let mut pending = pending.lock().await;
    while let Some(cmd) = pending.pop_front() {
        let _ = cmd.reply.send(Err(TmuxError::Disconnected));
    }
    if let Some(in_flight) = current.take() {
        let _ = in_flight.reply.send(Err(TmuxError::Disconnected));
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
    pending: Arc<Mutex<VecDeque<PendingReply>>>,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        // Register the pending reply BEFORE writing, so a racing
        // reader that sees `%begin` immediately after the flush
        // already has the oneshot to resolve against.
        pending.lock().await.push_back(PendingReply {
            reply: cmd.reply,
        });
        if let Err(e) = write_line(&mut stdin, &cmd.line).await {
            // Writer failed — peel the entry we just pushed and
            // resolve its oneshot with the I/O error, then bail
            // out of the loop so `shutdown` can clean up.
            if let Some(p) = pending.lock().await.pop_back() {
                let _ = p.reply.send(Err(TmuxError::Io(e)));
            }
            break;
        }
    }
    // Channel closed → no more commands coming. Resolve outstanding
    // pending commands with Disconnected. The reader task will also
    // see the stdin close and do the same, whichever gets there first
    // wins.
    let mut pending = pending.lock().await;
    while let Some(cmd) = pending.pop_front() {
        let _ = cmd.reply.send(Err(TmuxError::Disconnected));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
