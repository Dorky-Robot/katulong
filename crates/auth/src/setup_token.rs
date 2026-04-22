use crate::random::random_hex;
use crate::{AuthError, Result};
use rand_core::OsRng;
use scrypt::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use scrypt::{Params, Scrypt};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};

/// A single-use, time-limited token used to pair a new device.
///
/// Stored as a PHC-encoded scrypt hash — the hash string carries algorithm,
/// parameters, salt, and digest together, so raising the work factor later is
/// a per-record concern rather than a state-wide migration. (This is the
/// deliberate deviation from the Node implementation noted in `lib.rs`; Node
/// stores only `{hash, salt}` and has a prominent "don't change params"
/// warning in `auth-tokens.js` to avoid locking everyone out. See
/// `be5826b` for the scar.)
///
/// Records persist after consumption: `used_at` is stamped and
/// `credential_id` is linked so the UI can show "paired device <name>"
/// rather than losing the history, and so revoking a token cascades into
/// removing the device it created (Node scar: `7742ac3`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetupToken {
    pub id: String,
    pub hash: String,
    pub name: Option<String>,
    #[serde(with = "crate::state::systime")]
    pub created_at: SystemTime,
    #[serde(with = "crate::state::systime")]
    pub expires_at: SystemTime,
    #[serde(default, with = "crate::state::systime_opt")]
    pub used_at: Option<SystemTime>,
    #[serde(default)]
    pub credential_id: Option<String>,
}

/// The plaintext token produced by `issue`. Carry it carefully — it is the
/// only copy, and it's what the user will paste into the new device. Storing
/// it anywhere (logs, error messages, telemetry) defeats the hash.
pub type PlaintextToken = String;

impl SetupToken {
    /// Mint a new token record and its plaintext value.
    ///
    /// The plaintext is 32 random bytes encoded as hex (64 ASCII chars);
    /// it's URL-safe so the QR/pair-link flow can shove it straight into a
    /// query string without encoding tricks. The record's `id` is a separate
    /// short random ID used for revocation / linking — it is NOT the
    /// plaintext.
    pub fn issue(
        name: Option<String>,
        now: SystemTime,
        ttl: Duration,
    ) -> Result<(PlaintextToken, Self)> {
        let id = random_hex(8);
        let plaintext = random_hex(32);
        let hash = hash_token(&plaintext)?;
        Ok((
            plaintext,
            Self {
                id,
                hash,
                name,
                created_at: now,
                expires_at: now + ttl,
                used_at: None,
                credential_id: None,
            },
        ))
    }

    /// Verify a plaintext candidate against this record's hash. Constant-time
    /// in the plaintext length via scrypt's KDF comparison — no short-circuit
    /// on the hash bytes.
    pub fn verify(&self, plaintext: &str) -> bool {
        let Ok(parsed) = PasswordHash::new(&self.hash) else {
            return false;
        };
        Scrypt
            .verify_password(plaintext.as_bytes(), &parsed)
            .is_ok()
    }

    pub fn is_expired(&self, now: SystemTime) -> bool {
        now >= self.expires_at
    }

    pub fn is_consumed(&self) -> bool {
        self.used_at.is_some()
    }

    /// A token is usable only if it hasn't expired and hasn't been consumed.
    /// Fail-closed — mirrors Node's `findSetupToken` expiry guard.
    pub fn is_redeemable(&self, now: SystemTime) -> bool {
        !self.is_expired(now) && !self.is_consumed()
    }
}

/// scrypt work factor. Lower than OWASP's password-hashing recommendation
/// (log_n=17) because setup tokens are NOT user-chosen passwords — they
/// are 32 bytes of CSPRNG output (256 bits of entropy), so the brute-force
/// resistance we care about is already provided by the token itself. The
/// hash only needs to prevent disclosure-via-state-file from yielding
/// replay-usable plaintext within the token's few-hour lifetime. Matches
/// Node's `SCRYPT_N=16384` in `lib/auth-tokens.js`.
///
/// The params travel with each hash in the PHC string, so revisiting this
/// is a code-only change — existing tokens continue to verify with their
/// own params.
const SCRYPT_LOG_N: u8 = 14;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SCRYPT_KEY_LEN: usize = 32;

fn hash_token(plaintext: &str) -> Result<String> {
    let params = Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEY_LEN)
        .map_err(|e| AuthError::Hash(e.to_string()))?;
    let salt = SaltString::generate(&mut OsRng);
    Scrypt
        .hash_password_customized(plaintext.as_bytes(), None, None, params, &salt)
        .map(|h| h.to_string())
        .map_err(|e| AuthError::Hash(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch_plus(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn issue_and_verify_roundtrip() {
        let (plaintext, token) = SetupToken::issue(
            Some("iPad".into()),
            epoch_plus(0),
            Duration::from_secs(3600),
        )
        .unwrap();
        assert_eq!(plaintext.len(), 64);
        assert!(token.verify(&plaintext));
        assert!(!token.verify("wrong"));
        assert_eq!(token.name.as_deref(), Some("iPad"));
        assert_eq!(token.expires_at, epoch_plus(3600));
    }

    #[test]
    fn two_issues_differ() {
        let (p1, t1) = SetupToken::issue(None, epoch_plus(0), Duration::from_secs(60)).unwrap();
        let (p2, t2) = SetupToken::issue(None, epoch_plus(0), Duration::from_secs(60)).unwrap();
        assert_ne!(p1, p2);
        assert_ne!(t1.id, t2.id);
        assert_ne!(t1.hash, t2.hash);
    }

    #[test]
    fn is_expired_uses_now() {
        let (_, t) = SetupToken::issue(None, epoch_plus(100), Duration::from_secs(10)).unwrap();
        assert!(!t.is_expired(epoch_plus(109)));
        assert!(t.is_expired(epoch_plus(110)));
        assert!(t.is_expired(epoch_plus(200)));
    }

    #[test]
    fn hash_is_phc_encoded() {
        let (_, t) = SetupToken::issue(None, epoch_plus(0), Duration::from_secs(60)).unwrap();
        assert!(
            t.hash.starts_with("$scrypt$"),
            "expected PHC scrypt prefix, got: {}",
            t.hash
        );
    }

    #[test]
    fn corrupt_hash_fails_closed() {
        let (plaintext, mut t) =
            SetupToken::issue(None, epoch_plus(0), Duration::from_secs(60)).unwrap();
        t.hash = "not-a-phc-string".into();
        assert!(!t.verify(&plaintext));
    }

    #[test]
    fn serde_round_trip() {
        let (_, t) =
            SetupToken::issue(Some("mac".into()), epoch_plus(5), Duration::from_secs(60)).unwrap();
        let json = serde_json::to_string(&t).unwrap();
        let back: SetupToken = serde_json::from_str(&json).unwrap();
        assert_eq!(t, back);
    }
}
