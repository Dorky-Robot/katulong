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

    #[error("webauthn error: {0}")]
    WebAuthn(String),

    #[error("challenge not found or expired")]
    ChallengeNotFound,
}

impl AuthError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
