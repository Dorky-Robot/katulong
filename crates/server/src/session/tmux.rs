//! tmux control-mode client.
//!
//! Owns one long-running `tmux -C -L <socket>` subprocess and
//! speaks the protocol parsed by `super::parser`. Commands are
//! sent via the subprocess's stdin; replies and asynchronous
//! notifications arrive on stdout.
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
    #[error("tmux command failed: {0}")]
    CommandFailed(String),
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
    cmd_tx: mpsc::UnboundedSender<PendingCommand>,
    /// Held so we can `kill` on explicit shutdown. Behind `Arc<Mutex>`
    /// because tasks may call `shutdown` concurrently; at most one
    /// will actually dispatch the kill.
    child: Arc<Mutex<Option<Child>>>,
    /// The reader/writer tasks' join handles. Same reason: exactly
    /// one shutdown path should await them.
    tasks: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

struct PendingCommand {
    line: String,
    reply: oneshot::Sender<Result<CommandReply, TmuxError>>,
}

impl Tmux {
    /// Spawn `tmux -C -L <socket_name> new-session -d -s <session>
    /// -x <cols> -y <rows>` and begin the reader/writer tasks.
    ///
    /// `socket_name` must not be a path — tmux interprets `-L` as a
    /// name under `/tmp/tmux-$UID/`. Use `dedicated_socket_name()`
    /// for the convention.
    ///
    /// Returns the client handle plus an mpsc receiver for
    /// asynchronous notifications (`%output`, `%window-close`,
    /// ...). The caller is responsible for pumping that receiver;
    /// if it's dropped, notifications are silently discarded.
    pub async fn spawn(
        socket_name: &str,
        initial_session: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Notification>), TmuxError> {
        let mut cmd = Command::new("tmux");
        cmd.arg("-L")
            .arg(socket_name)
            .arg("-C")
            .arg("new-session")
            .arg("-d")
            .arg("-s")
            .arg(initial_session)
            .arg("-x")
            .arg(cols.to_string())
            .arg("-y")
            .arg(rows.to_string());
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

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<PendingCommand>();
        let (notif_tx, notif_rx) = mpsc::unbounded_channel::<Notification>();
        let pending: Arc<Mutex<VecDeque<PendingCommand>>> =
            Arc::new(Mutex::new(VecDeque::new()));

        let reader_handle =
            tokio::spawn(run_reader(stdout, notif_tx, Arc::clone(&pending)));
        let writer_handle = tokio::spawn(run_writer(stdin, cmd_rx, pending));

        Ok((
            Self {
                cmd_tx,
                child: Arc::new(Mutex::new(Some(child))),
                tasks: Arc::new(Mutex::new(vec![reader_handle, writer_handle])),
            },
            notif_rx,
        ))
    }

    /// Send one command to tmux and await the reply. `line` must
    /// not contain a newline — the writer appends `\n` itself.
    pub async fn send_command(&self, line: &str) -> Result<CommandReply, TmuxError> {
        if line.contains('\n') {
            return Err(TmuxError::CommandFailed(
                "command contains embedded newline".into(),
            ));
        }
        let (reply, rx) = oneshot::channel();
        self.cmd_tx
            .send(PendingCommand {
                line: line.to_string(),
                reply,
            })
            .map_err(|_| TmuxError::Disconnected)?;
        rx.await.map_err(|_| TmuxError::Disconnected)?
    }

    /// Kill the tmux subprocess and wait for the reader/writer
    /// tasks to finish. Idempotent — calling twice is safe; the
    /// second call no-ops.
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

/// Build the dedicated tmux socket name. Matches the Node
/// implementation's `-L katulong` convention so a migrated install
/// doesn't collide with the user's interactive tmux, and so staging
/// instances can use per-worktree sockets like `stage-<branch>`.
pub fn dedicated_socket_name() -> String {
    "katulong".to_string()
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
    pending: Arc<Mutex<VecDeque<PendingCommand>>>,
) {
    let mut reader = BufReader::new(stdout).lines();
    // When we see `%begin`, we pop the next pending command's
    // oneshot (already FIFO-ordered) and start collecting payload
    // lines into `current.payload`. `%end` or `%error` resolves
    // the oneshot.
    let mut current: Option<InFlightReply> = None;

    while let Ok(Some(line)) = reader.next_line().await {
        let n = match parse(&line) {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(error = %e, line = %line, "tmux parse error; dropping line");
                continue;
            }
        };
        match n {
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

async fn run_writer(
    mut stdin: ChildStdin,
    mut cmd_rx: mpsc::UnboundedReceiver<PendingCommand>,
    pending: Arc<Mutex<VecDeque<PendingCommand>>>,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        // Register the pending command BEFORE writing, so that if
        // tmux replies immediately on another task we don't race.
        let line = cmd.line.clone();
        let reply = cmd.reply;
        pending.lock().await.push_back(PendingCommand {
            line: line.clone(),
            reply,
        });
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            let popped = pending.lock().await.pop_back();
            if let Some(p) = popped {
                let _ = p.reply.send(Err(TmuxError::Io(e)));
            }
            break;
        }
        if let Err(e) = stdin.write_all(b"\n").await {
            let popped = pending.lock().await.pop_back();
            if let Some(p) = popped {
                let _ = p.reply.send(Err(TmuxError::Io(e)));
            }
            break;
        }
        if let Err(e) = stdin.flush().await {
            // Flush failed — best-effort resolve the just-queued cmd.
            let popped = pending.lock().await.pop_back();
            if let Some(p) = popped {
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
        let (tx, _rx) = mpsc::unbounded_channel();
        let t = Tmux {
            cmd_tx: tx.clone(),
            child: Arc::new(Mutex::new(None)),
            tasks: Arc::new(Mutex::new(vec![])),
        };
        drop(tx);
        drop(_rx);
        let err = t.send_command("list-sessions").await.unwrap_err();
        assert!(matches!(err, TmuxError::Disconnected));
    }

    #[test]
    fn embedded_newline_is_rejected_without_hitting_tmux() {
        // The write-a-newline guard must kick in before the mpsc
        // send — otherwise tmux would see a malformed partial
        // command.
        tokio_test::block_on(async {
            let (tx, _rx) = mpsc::unbounded_channel();
            let t = Tmux {
                cmd_tx: tx,
                child: Arc::new(Mutex::new(None)),
                tasks: Arc::new(Mutex::new(vec![])),
            };
            let err = t
                .send_command("list-sessions\nkill-server")
                .await
                .unwrap_err();
            assert!(matches!(err, TmuxError::CommandFailed(_)));
        });
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
