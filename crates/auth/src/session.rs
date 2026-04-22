use crate::random::random_hex;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime};

/// Default session lifetime: 30 days.
///
/// Matches the Node `SESSION_TTL_MS` constant (see Node commit `7b3bb1b`
/// for the consolidation scar — this value was independently redefined in
/// six places before being centralised; do not reintroduce a local
/// constant elsewhere).
pub const SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 30);

/// A browser session bound to a credential.
///
/// Carries a CSRF token and an activity timestamp to support the 30-day
/// sliding-expiry model from the Node version (commit `a242051`): fixed
/// expiry means a stolen cookie is valid for the full window regardless of
/// user activity; a sliding window extends the deadline only when the user
/// has been genuinely active.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub token: String,
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
    /// Mint a fresh session for `credential_id`, expiring `ttl` after `now`.
    ///
    /// Both the session token and the paired CSRF token are 32 random bytes
    /// from the OS CSPRNG, encoded as lowercase hex (64 ASCII chars each).
    /// That's 256 bits of entropy per token — comfortably past brute-force
    /// at any realistic rate, and the hex encoding stays transparent when it
    /// lands in cookies, forms, or logs.
    ///
    /// The caller is still responsible for persisting the result via
    /// `AuthStore::transact(|s| Ok((s.upsert_session(session.clone()),
    /// session)))` before sending the cookie. Minting without persisting
    /// would produce a token the server can't later recognise.
    pub fn mint(credential_id: impl Into<String>, now: SystemTime, ttl: Duration) -> Self {
        Self {
            token: random_hex(32),
            credential_id: credential_id.into(),
            csrf_token: random_hex(32),
            created_at: now,
            expires_at: now + ttl,
            last_activity_at: now,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_produces_distinct_tokens_on_each_call() {
        let a = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        let b = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        assert_ne!(a.token, b.token, "session tokens must be unique");
        assert_ne!(a.csrf_token, b.csrf_token, "csrf tokens must be unique");
        assert_ne!(
            a.token, a.csrf_token,
            "session and csrf tokens must be drawn independently"
        );
    }

    #[test]
    fn mint_sets_expiry_from_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let s = Session::mint("cred", now, Duration::from_secs(3600));
        assert_eq!(s.created_at, now);
        assert_eq!(s.expires_at, now + Duration::from_secs(3600));
        assert_eq!(s.last_activity_at, now);
    }

    #[test]
    fn token_shape_is_64_hex_chars() {
        let s = Session::mint("cred", SystemTime::UNIX_EPOCH, SESSION_TTL);
        assert_eq!(s.token.len(), 64, "32 bytes hex-encoded → 64 chars");
        assert!(
            s.token.chars().all(|c| c.is_ascii_hexdigit()),
            "token must be hex only"
        );
    }
}
