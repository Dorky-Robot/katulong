use std::path::PathBuf;
use thiserror::Error;

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
}

impl AuthError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}
