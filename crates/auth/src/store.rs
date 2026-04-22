use crate::{state::SCHEMA_VERSION, AuthError, AuthState, Result};
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

/// Imperative shell around `AuthState`. Every mutation flows through
/// `transact`, which serializes concurrent writers on a single mutex and
/// persists atomically before swapping the in-memory value.
///
/// This is the Rust analogue of Node's `withStateLock`/`persistAuthState`
/// pair (see commit `b97437a` for the race condition that motivated
/// centralising mutation through one path). Because `AuthState` is a pure
/// value type here, the "hold the lock long enough to read, compute, write"
/// discipline is structural — the closure literally cannot observe a
/// half-written state.
#[derive(Debug)]
pub struct AuthStore {
    path: PathBuf,
    state: Mutex<AuthState>,
}

impl AuthStore {
    /// Open an existing store or create an empty one at `path`.
    ///
    /// On first run we eagerly persist the empty state so a subsequent open
    /// doesn't silently race with a concurrent write (both would otherwise
    /// think the file doesn't exist and clobber each other's first write).
    pub async fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let state = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let parsed: AuthState = serde_json::from_slice(&bytes)?;
                if parsed.schema_version > SCHEMA_VERSION {
                    return Err(AuthError::UnsupportedVersion(parsed.schema_version));
                }
                parsed
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let fresh = AuthState::new();
                persist_atomic(&path, &fresh).await?;
                fresh
            }
            Err(e) => return Err(AuthError::io(&path, e)),
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    /// Apply a pure transition and persist the result.
    ///
    /// The closure receives an immutable snapshot and returns
    /// `(next_state, value)`. On `Ok`, the new state is written atomically
    /// and then swapped in memory; on `Err`, neither disk nor memory
    /// change. Persist failure leaves the in-memory state on the previous
    /// value — the closure's work is effectively rolled back.
    pub async fn transact<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&AuthState) -> Result<(AuthState, R)>,
    {
        let mut guard = self.state.lock().await;
        let (next, value) = f(&guard)?;
        persist_atomic(&self.path, &next).await?;
        *guard = next;
        Ok(value)
    }

    /// Cheap read-only snapshot. Holds the lock only long enough to clone.
    pub async fn snapshot(&self) -> AuthState {
        self.state.lock().await.clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Atomic write: serialize, write to a temp file in the same directory,
/// fsync, then rename over the target. Same-directory temp is required for
/// `rename(2)` to be atomic; a temp in `/tmp` would cross filesystems on
/// most Linux boxes and fall back to copy+unlink, which is NOT atomic.
///
/// Permissions are locked to `0600` on Unix before the rename — the rename
/// preserves the mode, so the final file is owner-only from the moment it
/// appears. We do this on the temp file rather than post-rename because
/// there's otherwise a window where a world-readable file exists at the
/// final path.
async fn persist_atomic(path: &Path, state: &AuthState) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(state)?;
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| AuthError::io(&path, e))?;
        }
        let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| AuthError::io(&path, e))?;
        tmp.write_all(&bytes).map_err(|e| AuthError::io(&path, e))?;
        tmp.as_file_mut()
            .sync_all()
            .map_err(|e| AuthError::io(&path, e))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o600))
                .map_err(|e| AuthError::io(&path, e))?;
        }

        tmp.persist(&path)
            .map_err(|e| AuthError::io(&path, e.error))?;
        Ok(())
    })
    .await
    .expect("persist task panicked")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Credential, Session};
    use std::time::{Duration, SystemTime};
    use tempfile::TempDir;

    fn cred(id: &str) -> Credential {
        Credential {
            id: id.into(),
            public_key: vec![1, 2, 3],
            name: None,
            counter: 0,
            created_at: SystemTime::UNIX_EPOCH,
            setup_token_id: None,
        }
    }

    fn sess(token: &str, cred_id: &str) -> Session {
        Session {
            token: token.into(),
            credential_id: cred_id.into(),
            csrf_token: "csrf".into(),
            created_at: SystemTime::UNIX_EPOCH,
            expires_at: SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            last_activity_at: SystemTime::UNIX_EPOCH,
        }
    }

    #[tokio::test]
    async fn open_creates_file_when_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        let store = AuthStore::open(&path).await.unwrap();
        assert!(path.exists(), "empty state should be persisted eagerly");
        assert_eq!(store.snapshot().await, AuthState::new());
    }

    #[tokio::test]
    async fn open_loads_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        {
            let store = AuthStore::open(&path).await.unwrap();
            store
                .transact(|s| Ok((s.upsert_credential(cred("a")), ())))
                .await
                .unwrap();
        }
        let reopened = AuthStore::open(&path).await.unwrap();
        assert!(reopened.snapshot().await.find_credential("a").is_some());
    }

    #[tokio::test]
    async fn transact_returns_closure_value() {
        let dir = TempDir::new().unwrap();
        let store = AuthStore::open(dir.path().join("auth.json")).await.unwrap();
        let token = store
            .transact(|s| {
                let next = s.add_session(sess("t", "a"));
                Ok((next, "t".to_string()))
            })
            .await
            .unwrap();
        assert_eq!(token, "t");
        assert!(store.snapshot().await.find_session("t").is_some());
    }

    #[tokio::test]
    async fn transact_error_leaves_state_unchanged() {
        let dir = TempDir::new().unwrap();
        let store = AuthStore::open(dir.path().join("auth.json")).await.unwrap();
        store
            .transact(|s| Ok((s.upsert_credential(cred("a")), ())))
            .await
            .unwrap();

        let before = store.snapshot().await;
        let err = store
            .transact(|_| Err::<(AuthState, ()), _>(AuthError::UnsupportedVersion(999)))
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::UnsupportedVersion(999)));
        assert_eq!(store.snapshot().await, before);
    }

    #[tokio::test]
    async fn unsupported_version_is_rejected() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        let raw = r#"{"schema_version":9999,"credentials":[],"sessions":[]}"#;
        tokio::fs::write(&path, raw).await.unwrap();
        let err = AuthStore::open(&path).await.unwrap_err();
        assert!(matches!(err, AuthError::UnsupportedVersion(9999)));
    }

    #[tokio::test]
    async fn persist_is_atomic_across_reopen() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        let store = AuthStore::open(&path).await.unwrap();
        for i in 0..10 {
            let id = format!("c{i}");
            store
                .transact(move |s| Ok((s.upsert_credential(cred(&id)), ())))
                .await
                .unwrap();
        }
        let bytes = tokio::fs::read(&path).await.unwrap();
        let parsed: AuthState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.credentials.len(), 10);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn persisted_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("auth.json");
        AuthStore::open(&path).await.unwrap();
        let mode = tokio::fs::metadata(&path)
            .await
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "auth state file must be owner-only");
    }
}
