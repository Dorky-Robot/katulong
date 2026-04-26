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
use super::router::OutputRouter;
use super::tmux::{Tmux, TmuxError};
use std::collections::HashSet;
use tokio::sync::mpsc;

use super::parser::Notification;

/// Public handle to the session layer. Construct with `new` at
/// server startup; clone into every handler that needs to touch
/// sessions.
///
/// SessionManager holds the **command CM** — the long-lived
/// control-mode client used for global queries
/// (`list-panes -a`, `list-sessions`, `kill-session`, etc.) and
/// for issuing `new-session` commands when tiles are created.
/// It is intentionally NOT a registry of per-tile state; each
/// per-tile `Tmux` instance is owned by the WS handler that
/// attached it. Lifecycle of per-tile CMs is tied to the
/// handler's task, not to this struct.
#[derive(Clone)]
pub struct SessionManager {
    tmux: Tmux,
}

impl SessionManager {
    pub fn new(tmux: Tmux) -> Self {
        Self { tmux }
    }

    /// Tmux socket this manager talks to. Delegates to the
    /// embedded `Tmux` (which owns the canonical
    /// `socket_name`). Per-tile `Tmux::attach` callers need it;
    /// exposed read-only.
    pub fn socket_name(&self) -> &str {
        self.tmux.socket_name()
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
            // tmux's "duplicate session" error is what we want to
            // treat as idempotent success: it means a concurrent
            // caller (or a prior aborted attempt) already created
            // this session. Mirrors the symmetric idempotency in
            // `destroy_session` (treats "can't find session" as
            // ok). Closes the ensure_session TOCTOU race PR #656
            // correctness review flagged HIGH.
            if reply.output.contains("duplicate session") {
                tracing::info!(
                    session = %name,
                    "session already exists; create_session is idempotent"
                );
                return Ok(());
            }
            return Err(SessionError::TmuxRejected(reply.output));
        }
        tracing::info!(session = %name, cols, rows, "session created");
        Ok(())
    }

    /// Idempotent variant of [`SessionManager::create_session`].
    /// Creates the session if it doesn't exist; no-op if it does.
    /// Used by [`SessionManager::attach_tile`] so a WS handler
    /// can ensure-and-attach in one call without coupling to
    /// who-creates-it ordering.
    ///
    /// Implementation is a `has-session` probe + conditional
    /// `new-session`. tmux's `new-session -A` flag advertises
    /// idempotency, but its semantics (attach the calling client
    /// if the session exists) don't match our use case — the
    /// command CM should NOT attach to user-tile sessions.
    pub async fn ensure_session(
        &self,
        name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), SessionError> {
        validate_session_name(name)?;
        let has = self
            .tmux
            .send_command(&format!("has-session -t {name}"))
            .await?;
        if has.ok {
            tracing::trace!(session = %name, "ensure_session: already exists");
            return Ok(());
        }
        self.create_session(name, cols, rows).await
    }

    /// Spawn a per-tile control-mode client attached to the named
    /// tile session. Ensures the session exists first.
    ///
    /// Returns the `Tmux` handle and its notification receiver.
    /// The returned `Tmux` owns a live CM subprocess (despite
    /// the method name — `attach` here means "attach a CM
    /// client to an existing tmux session," and that always
    /// involves spawning a subprocess).
    ///
    /// **Ownership transfers to the caller** — typically a WS
    /// handler. The caller is responsible for:
    /// - draining the notification receiver (the unbounded-
    ///   channel backpressure contract documented on
    ///   [`Tmux::spawn`] applies equally to receivers from
    ///   [`Tmux::attach`]),
    /// - calling [`Tmux::shutdown`] when the WS connection
    ///   tears down (clean detach avoids the tmux 3.6a UAF).
    ///
    /// `SessionManager` holds NO per-tile state. The tile's
    /// underlying tmux session persists across CM disconnects
    /// (a re-attach gets the same session); only the per-tile
    /// CM client lifetime is tied to the handler.
    pub async fn attach_tile(
        &self,
        name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(Tmux, mpsc::UnboundedReceiver<Notification>), SessionError> {
        self.ensure_session(name, cols, rows).await?;
        Tmux::attach(self.socket_name(), name)
            .await
            .map_err(SessionError::Tmux)
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
    /// the output router keys off.
    ///
    /// # Product invariant: one pane per tile, always
    ///
    /// Katulong's tile model is 1:1:1:1 — one tile = one tmux
    /// session = one tmux window = one tmux pane. Splits inside
    /// a tile are not a feature; the tile manager handles
    /// side-by-side layout by composing independent tiles, each
    /// with its own tmux session. A user who runs `split-window`
    /// or `new-window` from inside their katulong shell creates
    /// panes tmux can see but the router doesn't — those panes
    /// receive no I/O from katulong.
    ///
    /// So "the default pane" is just "the one pane this session
    /// has." We run `list-panes -t <session> -F '#{pane_id}'`
    /// and take the first line because under the invariant
    /// there's only one line. If tmux ever reports multiple,
    /// that's a bug state (e.g., a user-run `split-window`);
    /// handling it is out of scope — the katulong UX should
    /// prevent or reset that state, not patch around it here.
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

    /// Query tmux for the set of currently-live pane ids across
    /// every session it hosts. Runs `list-panes -a -F '#{pane_id}'`
    /// and parses the `%N` replies into a `HashSet<u32>`.
    ///
    /// Slice 9i uses this to reconcile the output router against
    /// tmux's view of reality. Tmux doesn't emit a per-pane close
    /// notification — only `%window-close @N` — and from window-
    /// id alone the router can't tell which panes were in that
    /// window. Re-querying the live set sidesteps the mapping
    /// problem: anything the router has that tmux no longer
    /// reports is a zombie.
    pub async fn list_live_panes(&self) -> Result<HashSet<u32>, SessionError> {
        let reply = self
            .tmux
            .send_command("list-panes -a -F '#{pane_id}'")
            .await?;
        if !reply.ok {
            return Err(SessionError::TmuxRejected(reply.output));
        }
        parse_pane_id_list(&reply.output)
    }

    /// Reconcile `router` against tmux's current set of live
    /// panes. Any pane registered on the router that tmux no
    /// longer reports gets evicted — its ring dropped, its
    /// subscribers' receivers closed, its handlers woken to
    /// `Action::Exit`. Returns the number of panes evicted.
    ///
    /// **Eviction driver (slice 9i).** The dispatcher calls this
    /// on `%window-close` / `%unlinked-window-close`
    /// notifications. Tmux emits window-level closures only
    /// (there's no `%pane-close`), so the pane→window mapping
    /// is reconstructed by querying tmux rather than tracked
    /// in Rust memory — consistent with the SessionManager's
    /// stateless design ("tmux is the source of truth").
    ///
    /// Fire-and-forget semantics from the dispatcher: on Err we
    /// log and move on. The next window-close event will try
    /// again; the router's `MAX_PANES` cap bounds the memory
    /// cost of any individual stale entry in the meantime.
    pub async fn reconcile_router(
        &self,
        router: &OutputRouter,
    ) -> Result<usize, SessionError> {
        // TOCTOU note: `list_live_panes` is an async tmux round-
        // trip; `retain_panes` runs later under the router lock.
        // A handler that calls `router.subscribe(P)` for a pane P
        // created between the query and the retain will see its
        // subscriber evicted immediately if P wasn't in `live`.
        // The subscriber's `output_rx` closes and the handler
        // wakes to `Action::Exit`; the client reconnects and the
        // pane is alive on the reconnect path. At katulong scale
        // (one or a few concurrent connections) the window is
        // narrow and the failure is self-healing — the pane is
        // still live in tmux, so the reconnect succeeds cleanly.
        let live = self.list_live_panes().await?;
        let evicted = router.retain_panes(&live);
        if evicted > 0 {
            tracing::info!(
                evicted,
                live_panes = live.len(),
                "reconciled output router against tmux live panes"
            );
        }
        Ok(evicted)
    }

    /// Default dimensions the session manager uses for new sessions
    /// when the client hasn't reported a real window size yet.
    pub fn default_dims() -> (u16, u16) {
        (DEFAULT_COLS, DEFAULT_ROWS)
    }
}

/// Errors returned by `SessionManager` operations.
///
/// **HTTP caller obligation.** `TmuxRejected` and `MalformedReply`
/// both wrap raw tmux output. Do NOT forward either to an HTTP
/// response body — they may contain socket paths, other session
/// names, or internal tmux details. Log the content server-side
/// and render a generic "session operation failed" to the
/// client. Same shape as the `AuthError::Io` obligation from
/// slice 1+2.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("invalid session name: {0:?}")]
    InvalidName(String),
    /// tmux acknowledged the command but reported an error
    /// (`%error` or `reply.ok == false`). Wraps the stderr/stdout
    /// payload. This is the "tmux said no" path.
    #[error("tmux rejected command: {0}")]
    TmuxRejected(String),
    /// tmux acknowledged the command successfully but the reply
    /// payload didn't match the format we asked for (e.g., a
    /// line in `list-panes -F '#{pane_id}'` output that's not a
    /// `%N` value). Distinct from `TmuxRejected` so callers and
    /// log scanners can tell "tmux said no" apart from "we
    /// couldn't parse tmux's answer." The latter usually
    /// indicates a tmux version or locale change on the host —
    /// actionable differently from a command rejection.
    #[error("tmux reply did not match expected format: {0}")]
    MalformedReply(String),
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

/// Parse a `%N\n%M\n...` block (tmux's `list-panes -F '#{pane_id}'`
/// output shape) into a set of numeric pane ids. Blank lines are
/// tolerated (trailing newline). Anything else that doesn't start
/// with `%` or fails to parse as u32 is rejected with
/// `SessionError::MalformedReply` — the command succeeded, but the
/// reply shape is wrong. Distinct from `TmuxRejected` (which means
/// tmux said no to the command itself).
///
/// We don't silently skip malformed lines because that could mask
/// a parser bug that leaves the router out of sync with tmux.
/// The hard-fail blast radius is one reconcile pass skipped: the
/// next `%window-close` / `%sessions-changed` event re-runs the
/// reconcile, and `MAX_PANES` bounds the interim memory cost.
fn parse_pane_id_list(raw: &str) -> Result<HashSet<u32>, SessionError> {
    let mut out = HashSet::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let rest = line.strip_prefix('%').ok_or_else(|| {
            SessionError::MalformedReply(format!("expected %N pane-id, got: {line:?}"))
        })?;
        let id = rest.parse::<u32>().map_err(|_| {
            SessionError::MalformedReply(format!("pane-id not numeric: {line:?}"))
        })?;
        out.insert(id);
    }
    Ok(out)
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

    // ---------- pane-id list parser ----------

    #[test]
    fn parse_pane_id_list_accepts_single_line() {
        let got = parse_pane_id_list("%3").unwrap();
        assert_eq!(got, [3].into_iter().collect());
    }

    #[test]
    fn parse_pane_id_list_accepts_multi_line() {
        let got = parse_pane_id_list("%1\n%5\n%42").unwrap();
        assert_eq!(got, [1, 5, 42].into_iter().collect());
    }

    #[test]
    fn parse_pane_id_list_tolerates_trailing_newline() {
        // tmux replies typically end with a newline. Skipping
        // empty lines prevents a spurious TmuxRejected on that.
        let got = parse_pane_id_list("%7\n").unwrap();
        assert_eq!(got, [7].into_iter().collect());
    }

    #[test]
    fn parse_pane_id_list_deduplicates() {
        // tmux shouldn't emit duplicates, but HashSet dedup means
        // we don't have to think about it.
        let got = parse_pane_id_list("%1\n%1\n%2").unwrap();
        assert_eq!(got, [1, 2].into_iter().collect());
    }

    #[test]
    fn parse_pane_id_list_empty_input_is_empty_set() {
        // If tmux reports no panes (server restart, all sessions
        // dead mid-reconcile), retain_panes(&empty) evicts every
        // zombie — exactly what we want.
        assert!(parse_pane_id_list("").unwrap().is_empty());
        assert!(parse_pane_id_list("\n").unwrap().is_empty());
    }

    #[test]
    fn parse_pane_id_list_rejects_missing_percent_prefix() {
        // Don't silently skip malformed lines — that could mask a
        // parser bug that leaves zombies in the router. Distinct
        // variant from TmuxRejected so log scanners can tell
        // "tmux said no" apart from "we failed to parse tmux's
        // reply."
        let err = parse_pane_id_list("3\n%5").unwrap_err();
        assert!(
            matches!(err, SessionError::MalformedReply(_)),
            "malformed reply must be MalformedReply, not TmuxRejected: {err:?}"
        );
    }

    #[test]
    fn parse_pane_id_list_rejects_non_numeric_id() {
        let err = parse_pane_id_list("%abc").unwrap_err();
        assert!(matches!(err, SessionError::MalformedReply(_)));
    }

    // ---------- Live-tmux integration ----------

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn reconcile_router_evicts_panes_of_destroyed_sessions() {
        // End-to-end: stand up a real tmux subprocess, create two
        // extra sessions, register their panes with the router,
        // destroy one, then reconcile. The destroyed session's
        // pane must be evicted from the router; the surviving
        // one must not.
        //
        // This test also empirically confirms that `list-panes
        // -a` reports across every session on the tmux server
        // regardless of which session the CM client is attached
        // to — that's the property slice 9i's reconcile depends
        // on. Per-session `%output` routing is a separate
        // concern (Path 1 follow-on).
        use super::super::router::OutputRouter;
        use super::super::tmux::Tmux;

        let socket = format!("katulong-reconcile-{}", std::process::id());
        let (tmux, _notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn tmux");
        let manager = SessionManager::new(tmux.clone());
        let router = OutputRouter::new();

        manager.create_session("alpha", 80, 24).await.unwrap();
        manager.create_session("beta", 80, 24).await.unwrap();

        let alpha_pane = manager.query_default_pane("alpha").await.unwrap();
        let beta_pane = manager.query_default_pane("beta").await.unwrap();
        assert_ne!(alpha_pane, beta_pane, "panes must be distinct");

        let (_alpha_rx, _alpha_id, _) = router.subscribe(alpha_pane).unwrap();
        let (_beta_rx, _beta_id, _) = router.subscribe(beta_pane).unwrap();
        assert_eq!(router.registered_count(), 2);

        manager.destroy_session("alpha").await.unwrap();

        let evicted = manager
            .reconcile_router(&router)
            .await
            .expect("reconcile succeeds");
        assert_eq!(evicted, 1, "alpha's pane evicted, beta's survives");
        assert_eq!(router.registered_count(), 1);
        assert_eq!(router.subscriber_count(beta_pane), 1);
        assert_eq!(router.subscriber_count(alpha_pane), 0);

        tmux.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn ensure_session_second_call_is_noop() {
        // Calling ensure_session twice for the same name must
        // succeed both times. Second call hits the has-session
        // pre-check and no-ops.
        use super::super::tmux::Tmux;

        let socket = format!("katulong-ensure-{}", std::process::id());
        let (tmux, _notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn tmux");
        let manager = SessionManager::new(tmux.clone());

        manager.ensure_session("tile-x", 80, 24).await.unwrap();
        manager
            .ensure_session("tile-x", 80, 24)
            .await
            .expect("second ensure must be a no-op");

        // Verify the session actually exists.
        let sessions = manager.list_sessions().await.unwrap();
        assert!(sessions.iter().any(|s| s == "tile-x"));

        tmux.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn attach_tile_returns_live_cm_for_existing_session() {
        // attach_tile must produce a Tmux whose CM is attached to
        // the named session. Verified by issuing a list-sessions
        // command through the per-tile CM and seeing the tile's
        // session in the reply.
        use super::super::tmux::Tmux;

        let socket = format!("katulong-attach-{}", std::process::id());
        let (cmd_tmux, _notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn cmd-tmux");
        let manager = SessionManager::new(cmd_tmux.clone());

        let (tile_tmux, _tile_notifs) = manager
            .attach_tile("tile-y", 80, 24)
            .await
            .expect("attach_tile");

        let reply = tile_tmux
            .send_command("list-sessions -F '#{session_name}'")
            .await
            .expect("list-sessions through tile CM");
        assert!(reply.ok);
        assert!(
            reply.output.contains("tile-y"),
            "tile-y session should appear in list-sessions: {}",
            reply.output
        );

        // Clean shutdown via in-band detach.
        tile_tmux.shutdown().await;
        cmd_tmux.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn create_session_treats_duplicate_as_idempotent() {
        // PR #656 round-1 HIGH fix: a concurrent attach race
        // where two callers both try to create the same session
        // must not surface tmux's "duplicate session" error to
        // the second caller. Repeat create_session twice and
        // expect both Ok.
        use super::super::tmux::Tmux;

        let socket = format!("katulong-dup-{}", std::process::id());
        let (tmux, _notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn tmux");
        let manager = SessionManager::new(tmux.clone());

        manager.create_session("tile-z", 80, 24).await.unwrap();
        // Second call must succeed (the "duplicate session" tmux
        // error is caught and treated as Ok).
        manager
            .create_session("tile-z", 80, 24)
            .await
            .expect("second create_session must be idempotent");

        tmux.shutdown().await;
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn shutdown_exits_cleanly_within_grace_period() {
        // Verifies the slice 9l shutdown path: send detach-client,
        // wait for clean exit, no SIGKILL fallback in the happy
        // path. The watchdog warning from `apply_note` style would
        // not fire on a healthy tmux.
        use super::super::tmux::Tmux;

        let socket = format!("katulong-detach-{}", std::process::id());
        let (tmux, _notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn tmux");

        // shutdown should return well within the SHUTDOWN_GRACE
        // budget (2s). If it took longer, the watchdog tripped
        // and we'd see a warn — but here the clean path should
        // be sub-100ms.
        let start = std::time::Instant::now();
        tmux.shutdown().await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "clean detach should be quick; took {elapsed:?}"
        );
    }

    #[tokio::test]
    #[ignore = "requires tmux binary + dedicated socket; run with: cargo test -- --ignored"]
    async fn tile_output_routes_through_per_tile_dispatcher() {
        // SLICE 9N END-TO-END: verifies that user-tile %output
        // actually reaches an OutputRouter subscriber via the
        // per-tile CM + spawn_output_pump path. This is
        // the architectural payoff of Path 1.
        //
        // Set up:
        //   command CM ── spawn keepalive session
        //   per-tile CM (via attach_tile) ── attached to tile
        //                                    session, runs
        //                                    user's default
        //                                    shell
        //   per-tile dispatcher ── routes %output to router
        //   router subscriber ── receives the shell's startup
        //                        prompt as the first chunk
        use super::super::router::OutputRouter;
        use super::super::tmux::Tmux;
        use std::time::Duration;

        let socket = format!("katulong-tile-output-{}", std::process::id());
        let (cmd_tmux, _cmd_notifs) = Tmux::spawn(&socket, "main", 80, 24)
            .await
            .expect("spawn command CM");
        let manager = SessionManager::new(cmd_tmux.clone());
        let router = OutputRouter::new();

        // Attach a tile + spawn its per-tile dispatcher. This
        // is the same wiring `try_attach` does in production.
        let (tile_tmux, tile_notifs) = manager
            .attach_tile("tile-out", 80, 24)
            .await
            .expect("attach_tile");
        let tile_disp = router.spawn_output_pump(tile_notifs);

        // Subscribe to the tile's pane on the router.
        let pane_id = manager
            .query_default_pane("tile-out")
            .await
            .expect("query pane");
        let (mut rx, _sub_id, _baseline) =
            router.subscribe(pane_id).expect("subscribe");

        // The default shell prints a prompt at startup, which
        // generates %output. 5s budget — generous on a normal
        // dev machine, tolerant of slow shell startups (e.g.,
        // a heavy ~/.bashrc, a loaded host).
        let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("output within 5s")
            .expect("subscriber received bytes");
        assert!(
            !chunk.data.is_empty(),
            "shell startup should produce non-empty %output via per-tile CM"
        );

        tile_disp.abort();
        let _ = tile_disp.await;
        tile_tmux.shutdown().await;
        cmd_tmux.shutdown().await;
    }
}
