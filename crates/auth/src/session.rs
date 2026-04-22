use crate::random::random_hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::time::{Duration, SystemTime};

/// Default session lifetime: 30 days.
///
/// Matches the Node `SESSION_TTL_MS` constant (see Node commit `7b3bb1b`
/// for the consolidation scar — this value was independently redefined in
/// six places before being centralised; do not reintroduce a local
/// constant elsewhere).
pub const SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 30);

/// The plaintext session-token string that goes to the client as a
/// cookie value. Produced once by `Session::mint` alongside the record
/// that gets persisted; after mint the server only ever compares hashes
/// against this value (see `AuthState::find_session`).
pub type SessionTokenPlaintext = String;

/// A browser session bound to a credential.
///
/// The `token_hash` field stores SHA-256 of the plaintext session token,
/// hex-encoded. The plaintext is delivered to the client once — by
/// `Session::mint`'s return tuple — and never stored on disk. On every
/// subsequent request the server hashes the candidate cookie value and
/// constant-time compares against `token_hash`. Consequence: a stolen
/// auth-state file exposes only hashes, not replay-usable cookies. The
/// entropy of the plaintext (256 bits from CSPRNG) already makes
/// brute-force impossible, so SHA-256 (fast, deterministic) is the
/// right primitive — scrypt-level work factor would be overkill and
/// make every request slower for no gain.
///
/// Carries a CSRF token and an activity timestamp to support the 30-day
/// sliding-expiry model from the Node version (commit `a242051`): fixed
/// expiry means a stolen cookie is valid for the full window regardless of
/// user activity; a sliding window extends the deadline only when the user
/// has been genuinely active.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    /// SHA-256 of the plaintext token, hex-encoded (64 chars). See
    /// struct docs for the rationale. Never equal to the plaintext.
    pub token_hash: String,
    pub credential_id: String,
    pub csrf_token: String,
    #[serde(with = "crate::state::systime")]
    pub created_at: SystemTime,
    #[serde(with = "crate::state::systime")]
    pub expires_at: SystemTime,
    #[serde(with = "crate::state::systime")]
    pub last_activity_at: SystemTime,
}

impl Session {
    /// Mint a fresh session for `credential_id`, expiring `ttl` after
    /// `now`. Returns `(plaintext_token, session)`:
    /// - The plaintext is 32 random bytes from the OS CSPRNG, hex-encoded
    ///   (64 ASCII chars, 256 bits of entropy). Send this to the client
    ///   via the session cookie and DO NOT store it anywhere server-side.
    /// - The `Session` value carries `token_hash` (SHA-256 of the
    ///   plaintext), the CSRF token, and timestamps — this is what
    ///   lands on disk.
    ///
    /// The caller is still responsible for persisting the returned
    /// `Session` via `AuthStore::transact(|s| Ok((s.upsert_session(
    /// session.clone()), session)))` before sending the cookie. Minting
    /// without persisting would produce a hash the server can't later
    /// match.
    pub fn mint(
        credential_id: impl Into<String>,
        now: SystemTime,
        ttl: Duration,
    ) -> (SessionTokenPlaintext, Self) {
        let plaintext = random_hex(32);
        let session = Self {
            token_hash: hash_session_token(&plaintext),
            credential_id: credential_id.into(),
            csrf_token: random_hex(32),
            created_at: now,
            expires_at: now + ttl,
            last_activity_at: now,
        };
        (plaintext, session)
    }
}

/// SHA-256 hash of a plaintext session token, hex-encoded. 64 chars.
///
/// Used both at mint time (`Session::mint`) and at lookup time
/// (`AuthState::find_session`). Keeping it as a crate-private helper
/// means "how do we hash a session token?" has exactly one answer
/// visible from both mint and verify paths.
pub(crate) fn hash_session_token(plaintext: &str) -> String {
    let digest = Sha256::new().chain_update(plaintext.as_bytes()).finalize();
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        write!(&mut out, "{b:02x}").expect("write to String cannot fail");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_produces_distinct_tokens_on_each_call() {
        let (a_plain, a) = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        let (b_plain, b) = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        assert_ne!(a_plain, b_plain, "plaintext tokens must be unique");
        assert_ne!(a.token_hash, b.token_hash, "hashes must differ too");
        assert_ne!(a.csrf_token, b.csrf_token, "csrf tokens must be unique");
        assert_ne!(
            a_plain, a.csrf_token,
            "session and csrf tokens must be drawn independently"
        );
    }

    #[test]
    fn mint_sets_expiry_from_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let (_, s) = Session::mint("cred", now, Duration::from_secs(3600));
        assert_eq!(s.created_at, now);
        assert_eq!(s.expires_at, now + Duration::from_secs(3600));
        assert_eq!(s.last_activity_at, now);
    }

    #[test]
    fn plaintext_shape_is_64_hex_chars() {
        let (plaintext, _) = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        assert_eq!(plaintext.len(), 64, "32 bytes hex-encoded → 64 chars");
        assert!(
            plaintext.chars().all(|c| c.is_ascii_hexdigit()),
            "token must be hex only"
        );
    }

    #[test]
    fn stored_hash_is_not_plaintext() {
        // Paranoid: verify we never accidentally store the plaintext
        // in the hash field.
        let (plaintext, s) = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        assert_ne!(
            plaintext, s.token_hash,
            "storing the plaintext defeats the hash"
        );
        assert_eq!(
            hash_session_token(&plaintext),
            s.token_hash,
            "the stored hash must be SHA-256 of the returned plaintext"
        );
    }

    #[test]
    fn hash_is_deterministic() {
        let h1 = hash_session_token("abc");
        let h2 = hash_session_token("abc");
        assert_eq!(h1, h2);
        assert_ne!(h1, hash_session_token("abd"));
        assert_eq!(h1.len(), 64);
    }
}
