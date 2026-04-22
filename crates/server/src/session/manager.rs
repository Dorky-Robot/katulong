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
                return Ok(());
            }
            return Err(SessionError::TmuxRejected(reply.output));
        }
        Ok(())
    }

    /// Resize a session's default pane to the given dimensions.
    /// Clamps per `dims::clamp_dims`. Slice-9c will use this from
    /// explicit client events (attach, detach, window-resize) — do
    /// NOT call on every keystroke (SIGWINCH storms garble TUI
    /// apps; see `dims.rs`).
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

    /// Default dimensions the session manager uses for new sessions
    /// when the client hasn't reported a real window size yet.
    pub fn default_dims() -> (u16, u16) {
        (DEFAULT_COLS, DEFAULT_ROWS)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session name contains forbidden character: {0:?}")]
    InvalidName(String),
    #[error("tmux rejected command: {0}")]
    TmuxRejected(String),
    #[error("tmux error: {0}")]
    Tmux(#[from] TmuxError),
}

/// Reject session names that would confuse tmux's target parser.
/// tmux uses `:` as window separator, `.` as pane separator, and
/// `$`/`@`/`%` as id prefixes; a name containing any of those can
/// be misinterpreted depending on context. Whitespace and shell
/// metacharacters also rejected — belt and suspenders, because the
/// command is written as a single line without shell escaping.
fn validate_session_name(name: &str) -> Result<(), SessionError> {
    if name.is_empty() {
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
    fn default_dims_are_the_module_constants() {
        assert_eq!(
            SessionManager::default_dims(),
            (DEFAULT_COLS, DEFAULT_ROWS)
        );
    }
}
