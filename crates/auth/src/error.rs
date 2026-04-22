use std::path::PathBuf;
use thiserror::Error;

/// Errors surfaced by the auth crate.
///
/// **Caller obligation (HTTP / tunnel surface):** variants here carry
/// server-side context — `Io` embeds the on-disk state path; `Parse` and
/// `Hash` can include library-level detail — and their `Display` output is
/// intended for server logs, never for HTTP response bodies. A future HTTP
/// layer must translate these into opaque status codes (`500`, `401`,
/// etc.) and must not render the full error chain back to the client. The
/// Node implementation learned this the hard way (see commit `c51ea9d`);
/// don't relitigate it.
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("io error on {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("failed to parse auth state: {0}")]
    Parse(#[from] serde_json::Error),

    #[error("unsupported auth state schema version: {0}")]
    UnsupportedVersion(u32),

    #[error("password-hash error: {0}")]
    Hash(String),

    /// WebAuthn service misconfiguration surfaced at startup — bad origin
    /// URL, RP-id mismatch, missing feature on the relying-party builder.
    /// Maps to a 500-class response if it ever reached an HTTP layer, but
    /// in practice should panic the process at init rather than be served.
    /// Kept distinct from `WebAuthn` so a 401-class ceremony failure isn't
    /// indistinguishable from a startup bug via string-matching.
    #[error("webauthn configuration error: {0}")]
    WebAuthnConfig(String),

    /// Runtime WebAuthn ceremony failure — signature verification failed,
    /// challenge response malformed, counter regressed, etc. Caller should
    /// render this as 401 and prompt the user to retry.
    #[error("webauthn error: {0}")]
    WebAuthn(String),

    #[error("challenge not found or expired")]
    ChallengeNotFound,

    /// The server is at capacity for pending registration/authentication
    /// ceremonies. Caller should render as 503 and ask the user to retry in
    /// a few seconds. See the `MAX_PENDING_CHALLENGES` cap in `webauthn.rs`
    /// — this variant exists so an HTTP handler can distinguish "retry
    /// shortly" from "something is permanently broken."
    #[error("too many pending challenges")]
    TooManyPendingChallenges,

    /// A state-level invariant was violated while inside an
    /// `AuthStore::transact` closure — the check that gates the
    /// transition saw a state that wouldn't permit it. Raised
    /// specifically to make the TOCTOU-safe pattern usable: a handler
    /// can do a fast-fail guard outside the mutex AND re-check the same
    /// invariant inside the closure, with the inner check's error
    /// routing to the same HTTP `Conflict` shape as the outer one.
    #[error("state conflict: {0}")]
    StateConflict(&'static str),

    /// A transact closure refused to remove the only remaining
    /// credential on this instance. Raised by the device-revoke
    /// handler for remote callers when `credentials.len() == 1` —
    /// allowing the deletion would lock them out of their own
    /// install over the tunnel (Node scar `f25855f`). Dedicated
    /// variant so the HTTP layer can typed-discriminate without
    /// matching on `StateConflict`'s string payload; the compiler
    /// enforces the pairing rather than a literal on both sides.
    #[error("cannot remove the last credential")]
    LastCredentialRemoval,
}

impl AuthError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
