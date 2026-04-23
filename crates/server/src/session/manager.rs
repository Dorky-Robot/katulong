//! Session lifecycle manager — the katulong-side view of tmux
//! sessions.
//!
//! Wraps one `Tmux` client and exposes the operations
//! handlers need: create a session, list existing sessions,
//! destroy by id. Every call routes through tmux's control-mode
//! command channel; we don't keep a second source of truth in
//! Rust memory beyond what we need to enforce dimension discipline.
//!
//! # Slice 9b scope
//!
//! Scaffold only. No output streaming, no RingBuffer, no attach
//! semantics, no WS integration. Methods return as soon as tmux
//! ACKs the command — consumers of the session (output, input,
//! resize) come in slice 9c.
//!
//! # Concurrency
//!
//! `SessionManager` is `Clone` (the inner `Tmux` handle is). That
//! means multiple HTTP handlers can issue session commands
//! concurrently; the tmux client's internal writer serializes them
//! onto the subprocess's stdin. There's no in-memory cache to race.

use super::dims::{clamp_dims, DEFAULT_COLS, DEFAULT_ROWS};
use super::tmux::{Tmux, TmuxError};

/// Public handle to the session layer. Construct with `new` at
/// server startup; clone into every handler that needs to touch
/// sessions.
#[derive(Clone)]
pub struct SessionManager {
    tmux: Tmux,
}

impl SessionManager {
    pub fn new(tmux: Tmux) -> Self {
        Self { tmux }
    }

    /// Create a new tmux session with the given name and initial
    /// dimensions. Returns when tmux confirms the session exists.
    ///
    /// `cols`/`rows` are clamped via `dims::clamp_dims` before
    /// reaching tmux — we never ask tmux to create a 10000-column
    /// session because the client lied about its window size.
    /// The `session::handler` coordinator clamps again before
    /// calling here; that's intentional belt-and-suspenders, NOT
    /// redundancy to delete. Defense in depth: if a future caller
    /// (CLI, admin API, tests) forgets to clamp, this internal
    /// clamp keeps tmux safe. Since `clamp_dims` is idempotent,
    /// the double call has no observable effect.
    ///
    /// `name` must be a tmux-safe session identifier: no spaces, no
    /// colons, no periods, no dollar-signs (which tmux interprets as
    /// target specifiers). Callers that accept names from clients
    /// should enforce a character set; the validation here is a
    /// best-effort reject of the characters that would cause tmux to
    /// misinterpret the command rather than fail.
    pub async fn create_session(
        &self,
        name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError> {
        validate_session_name(name)?;
        let (cols, rows) = clamp_dims(cols, rows);
        let cmd = format!(
            "new-session -d -s {name} -x {cols} -y {rows}",
            name = name,
            cols = cols,
            rows = rows
        );
        let reply = self.tmux.send_command(&cmd).await?;
        if !reply.ok {
            return Err(SessionError::TmuxRejected(reply.output));
        }
        tracing::info!(session = %name, cols, rows, "session created");
        Ok(())
    }

    /// List session names currently running on tmux. Returns them in
    /// whatever order tmux reports; no sort guarantees.
    pub async fn list_sessions(&self) -> Result<Vec<String>, SessionError> {
        let reply = self
            .tmux
            .send_command("list-sessions -F '#{session_name}'")
            .await?;
        if !reply.ok {
            // `list-sessions` on a server with zero sessions
            // actually errors with "no server running" in some tmux
            // versions — but our session manager always has at
            // least the initial session created on spawn. If we see
            // it, surface the tmux error rather than silently
            // returning empty.
            return Err(SessionError::TmuxRejected(reply.output));
        }
        Ok(reply
            .output
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect())
    }

    /// Destroy a session by name. Idempotent — killing a session
    /// that doesn't exist returns Ok (tmux reports an error but we
    /// translate it into "nothing to do").
    pub async fn destroy_session(&self, name: &str) -> Result<(), SessionError> {
        validate_session_name(name)?;
        let cmd = format!("kill-session -t {name}");
        let reply = self.tmux.send_command(&cmd).await?;
        if !reply.ok {
            // tmux's "can't find session" error is what we want to
            // treat as idempotent success. Any other error is real.
            if reply.output.contains("can't find session")
                || reply.output.contains("session not found")
            {
                tracing::info!(session = %name, "session destroy requested (not found; idempotent)");
                return Ok(());
            }
            return Err(SessionError::TmuxRejected(reply.output));
        }
        tracing::info!(session = %name, "session destroyed");
        Ok(())
    }

    /// Resize a session's default pane to the given dimensions.
    /// Clamps per `dims::clamp_dims`. Slice-9c will use this from
    /// explicit client events (attach, detach, window-resize) — do
    /// NOT call on every keystroke (SIGWINCH storms garble TUI
    /// apps; see `dims.rs`).
    ///
    /// **tmux command choice.** `refresh-client -C` is synchronous
    /// in control mode: it processes in-band with the command
    /// stream, so the new window size takes effect before any
    /// subsequent `%output`. `resize-window` (the async
    /// alternative) races with the output stream and flips tmux's
    /// `window-size` to `manual`, breaking subsequent
    /// `refresh-client -C`s. Node scar `09c0542` says stay in-band
    /// for operations that must be ordered relative to output.
    pub async fn resize_session(
        &self,
        name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError> {
        validate_session_name(name)?;
        let (cols, rows) = clamp_dims(cols, rows);
        let cmd = format!(
            "refresh-client -t {name} -C {cols},{rows}",
            name = name,
            cols = cols,
            rows = rows
        );
        let reply = self.tmux.send_command(&cmd).await?;
        if !reply.ok {
            return Err(SessionError::TmuxRejected(reply.output));
        }
        Ok(())
    }

    /// Look up the default pane id for `session`. Returns the
    /// numeric pane id (tmux's `%N` with the `%` stripped) that
    /// the output router keys off. For a session freshly created
    /// by `create_session`, the first `list-panes` result IS the
    /// default pane, because tmux creates the session with a
    /// single window hosting a single pane.
    ///
    /// Called exactly once per `Attach` — the session-to-pane
    /// mapping can change if the user runs tmux commands that
    /// create windows/panes, but katulong's current single-pane-
    /// per-session assumption (session 9h will revisit) means
    /// we resolve once at attach time.
    pub async fn query_default_pane(&self, session: &str) -> Result<u32, SessionError> {
        validate_session_name(session)?;
        let cmd = format!("list-panes -t {session} -F '#{{pane_id}}'");
        let reply = self.tmux.send_command(&cmd).await?;
        if !reply.ok {
            return Err(SessionError::TmuxRejected(reply.output));
        }
        let first = reply.output.lines().next().unwrap_or("").trim();
        let rest = first.strip_prefix('%').ok_or_else(|| {
            SessionError::TmuxRejected(format!("unexpected pane-id reply: {first:?}"))
        })?;
        rest.parse::<u32>().map_err(|_| {
            SessionError::TmuxRejected(format!("invalid pane-id in reply: {first:?}"))
        })
    }

    /// Forward client keystroke bytes to a specific pane as
    /// `send-keys -t %<pane_id> -H <hex-pairs>`. `-H` takes
    /// space-separated two-digit hex values, so every byte
    /// (including control chars like Ctrl-C `0x03` or arrow keys
    /// `1b 5b 41`) rides through without shell quoting or
    /// encoding loss.
    ///
    /// **Why `send-keys -H` and not stdin write.** tmux in
    /// control mode exposes stdin for COMMANDS, not for pane
    /// data — there's no other supported channel from our side
    /// to the pane. `send-keys -H` is explicitly binary-safe and
    /// tmux has shipped it since 2.4. Alternatives considered:
    /// `-l` (literal text) mangles control chars; `paste-buffer`
    /// requires a second command per paste and is paste-flavored
    /// (hits paste bracketing).
    ///
    /// Empty input is a no-op — we don't bother tmux for zero
    /// bytes. Slice 9g/9h considerations: large pastes (up to
    /// the 64 KiB frame cap) encode to ~192 KiB command lines
    /// (3× hex overhead); tmux accepts multi-hundred-KB command
    /// strings in practice, but truly enormous pastes should be
    /// fragmented client-side. The existing client-side
    /// fragmentation implied by `MAX_INBOUND_FRAME_BYTES`
    /// handles this.
    pub async fn send_input(&self, pane_id: u32, data: &[u8]) -> Result<(), SessionError> {
        if data.is_empty() {
            return Ok(());
        }
        // Pre-size the string: "send-keys -t %<id> -H" + 3 chars/byte.
        let mut cmd = String::with_capacity(32 + data.len() * 3);
        use std::fmt::Write;
        write!(&mut cmd, "send-keys -t %{pane_id} -H").expect("writing to String never fails");
        for b in data {
            write!(&mut cmd, " {b:02x}").expect("writing to String never fails");
        }
        let reply = self.tmux.send_command(&cmd).await?;
        if !reply.ok {
            return Err(SessionError::TmuxRejected(reply.output));
        }
        Ok(())
    }

    /// Default dimensions the session manager uses for new sessions
    /// when the client hasn't reported a real window size yet.
    pub fn default_dims() -> (u16, u16) {
        (DEFAULT_COLS, DEFAULT_ROWS)
    }
}

/// Errors returned by `SessionManager` operations.
///
/// **HTTP caller obligation.** `TmuxRejected` wraps tmux's raw
/// stderr/stdout output. Do NOT forward that to an HTTP response
/// body — it may contain socket paths, other session names, or
/// internal tmux details. Log the content server-side and render
/// a generic "session operation failed" to the client. Same shape
/// as the `AuthError::Io` obligation from slice 1+2.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("invalid session name: {0:?}")]
    InvalidName(String),
    #[error("tmux rejected command: {0}")]
    TmuxRejected(String),
    #[error("tmux error: {0}")]
    Tmux(#[from] TmuxError),
}

/// Hard cap on session-name length. tmux itself accepts names up
/// to `PATH_MAX`-ish, but no legitimate katulong session needs
/// anywhere near that. Clipping to 64 bytes keeps the error path
/// cheap (no multi-KiB `format!` allocations for tmux commands we
/// know will fail) and keeps log lines readable when a bad name
/// gets rejected. An authenticated client could still burn a
/// round trip per attempted `Attach`, but not arbitrary memory.
const MAX_SESSION_NAME_LEN: usize = 64;

/// Reject session names that would confuse tmux's target parser.
/// tmux uses `:` as window separator, `.` as pane separator, and
/// `$`/`@`/`%` as id prefixes; a name containing any of those can
/// be misinterpreted depending on context. Whitespace and shell
/// metacharacters also rejected — belt and suspenders, because the
/// command is written as a single line without shell escaping.
///
/// **Leading-hyphen rule.** A name starting with `-` is rejected
/// even though `-` is allowed mid-name. Without this check, a
/// name like `-a` passed to `kill-session -t {name}` renders as
/// `kill-session -t -a`, which tmux's `getopt` parser reads as
/// two flags — and on some tmux versions `-a` means "kill all
/// sessions except the attached one." An authenticated caller
/// could then nuke every session by naming one `-a`. The allowlist
/// alone didn't cover this argument-injection edge.
///
/// **Length cap.** Names over `MAX_SESSION_NAME_LEN` bytes fail
/// validation — see the constant's doc for the rationale.
fn validate_session_name(name: &str) -> Result<(), SessionError> {
    if name.is_empty() || name.starts_with('-') || name.len() > MAX_SESSION_NAME_LEN {
        return Err(SessionError::InvalidName(name.to_string()));
    }
    for c in name.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !ok {
            return Err(SessionError::InvalidName(name.to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_name_accepts_alphanumeric_and_dash_underscore() {
        assert!(validate_session_name("session-1").is_ok());
        assert!(validate_session_name("my_session").is_ok());
        assert!(validate_session_name("ABC123").is_ok());
    }

    #[test]
    fn session_name_rejects_tmux_target_specifiers() {
        for bad in [":", ".", "$", "@", "%"] {
            assert!(
                validate_session_name(bad).is_err(),
                "tmux target specifier {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn session_name_rejects_whitespace_and_metachars() {
        for bad in [" ", "a b", "a\tb", ";", "|", "&", "`", "'", "\""] {
            assert!(
                validate_session_name(bad).is_err(),
                "dangerous char {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn session_name_rejects_empty() {
        assert!(validate_session_name("").is_err());
    }

    #[test]
    fn session_name_rejects_leading_hyphen() {
        // Critical argument-injection guard: `kill-session -t -a`
        // reads as two flags on tmux, with `-a` meaning "kill all
        // other sessions." An authenticated caller passing name="-a"
        // would otherwise destroy every session. See the doc on
        // `validate_session_name` for the full reasoning.
        for bad in ["-", "-a", "-bad", "-kill-everything"] {
            assert!(
                validate_session_name(bad).is_err(),
                "name starting with hyphen {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn session_name_permits_hyphen_mid_name() {
        // Hyphens are fine anywhere except the first position.
        assert!(validate_session_name("my-session").is_ok());
        assert!(validate_session_name("a-b-c").is_ok());
    }

    #[test]
    fn session_name_rejects_oversize() {
        // Authenticated callers could otherwise ask the manager to
        // allocate multi-KiB tmux command strings per Attach
        // attempt. Cap at `MAX_SESSION_NAME_LEN`.
        let at_limit = "a".repeat(MAX_SESSION_NAME_LEN);
        assert!(validate_session_name(&at_limit).is_ok());
        let over_limit = "a".repeat(MAX_SESSION_NAME_LEN + 1);
        assert!(validate_session_name(&over_limit).is_err());
    }

    #[test]
    fn default_dims_are_the_module_constants() {
        assert_eq!(
            SessionManager::default_dims(),
            (DEFAULT_COLS, DEFAULT_ROWS)
        );
    }
}
