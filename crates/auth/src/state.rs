use crate::{Credential, Session, SetupToken};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

/// Immutable auth state. Every transition takes `&self` and returns owned
/// `Self` — there is no in-place mutation.
///
/// The schema version gives us a deliberate place to hang migrations when
/// the on-disk format changes. New fields should land with `#[serde(default)]`
/// so older state files still deserialize without a version bump.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthState {
    #[serde(default = "current_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub credentials: Vec<Credential>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub setup_tokens: Vec<SetupToken>,
}

pub(crate) const SCHEMA_VERSION: u32 = 1;

fn current_schema_version() -> u32 {
    SCHEMA_VERSION
}

impl Default for AuthState {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            credentials: Vec::new(),
            sessions: Vec::new(),
            setup_tokens: Vec::new(),
        }
    }
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }

    // ---------- Pure queries ----------

    pub fn find_credential(&self, id: &str) -> Option<&Credential> {
        self.credentials.iter().find(|c| c.id == id)
    }

    pub fn find_session(&self, token: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.token == token)
    }

    /// `find_session` plus an expiry check. Returns `None` if the session is
    /// missing or has already expired at `now`.
    pub fn valid_session(&self, token: &str, now: SystemTime) -> Option<&Session> {
        self.find_session(token).filter(|s| now < s.expires_at)
    }

    pub fn find_setup_token(&self, id: &str) -> Option<&SetupToken> {
        self.setup_tokens.iter().find(|t| t.id == id)
    }

    /// Look up a setup token by its plaintext value, validating expiry and
    /// single-use in one shot.
    ///
    /// Walks every record and runs `verify` without short-circuiting — the
    /// scrypt verification is the expensive step, so we eat the cost uniformly
    /// rather than leaking "a matching record existed" via a timing channel
    /// (Node does the same, see `auth-state.js::findSetupToken`). With the
    /// handful of setup tokens katulong ever holds at once this is a
    /// negligible cost for a genuinely nice property.
    ///
    /// Returns `None` if the token is missing, expired, or already consumed —
    /// fail-closed matches Node's `expiresAt`/`usedAt` guard.
    pub fn find_redeemable_setup_token(
        &self,
        plaintext: &str,
        now: SystemTime,
    ) -> Option<&SetupToken> {
        let mut found: Option<&SetupToken> = None;
        for t in &self.setup_tokens {
            if t.verify(plaintext) && found.is_none() {
                found = Some(t);
            }
        }
        found.filter(|t| t.is_redeemable(now))
    }

    // ---------- Pure transitions ----------

    /// Add or replace a credential by id.
    pub fn upsert_credential(&self, cred: Credential) -> Self {
        let mut credentials: Vec<Credential> = self
            .credentials
            .iter()
            .filter(|c| c.id != cred.id)
            .cloned()
            .collect();
        credentials.push(cred);
        Self {
            credentials,
            ..self.clone()
        }
    }

    /// Remove a credential and all sessions bound to it. Cascading the
    /// session removal here prevents orphans and matches the Node
    /// `endSession`/credential-revocation semantics.
    pub fn remove_credential(&self, id: &str) -> Self {
        Self {
            credentials: self
                .credentials
                .iter()
                .filter(|c| c.id != id)
                .cloned()
                .collect(),
            sessions: self
                .sessions
                .iter()
                .filter(|s| s.credential_id != id)
                .cloned()
                .collect(),
            ..self.clone()
        }
    }

    pub fn add_session(&self, session: Session) -> Self {
        let mut sessions = self.sessions.clone();
        sessions.retain(|s| s.token != session.token);
        sessions.push(session);
        Self {
            sessions,
            ..self.clone()
        }
    }

    pub fn remove_session(&self, token: &str) -> Self {
        Self {
            sessions: self
                .sessions
                .iter()
                .filter(|s| s.token != token)
                .cloned()
                .collect(),
            ..self.clone()
        }
    }

    /// Drop sessions whose `expires_at` is at or before `now`.
    pub fn prune_expired(&self, now: SystemTime) -> Self {
        Self {
            sessions: self
                .sessions
                .iter()
                .filter(|s| now < s.expires_at)
                .cloned()
                .collect(),
            ..self.clone()
        }
    }

    /// Record activity on a session. No-op if the token isn't found.
    ///
    /// Sliding-expiry policy (when to also bump `expires_at`) lives with the
    /// caller; this transition only records the observation so tests stay
    /// straightforward and policy is free to evolve.
    pub fn touch_session(&self, token: &str, now: SystemTime) -> Self {
        Self {
            sessions: self
                .sessions
                .iter()
                .map(|s| {
                    if s.token == token {
                        Session {
                            last_activity_at: now,
                            ..s.clone()
                        }
                    } else {
                        s.clone()
                    }
                })
                .collect(),
            ..self.clone()
        }
    }

    /// Extend a session's expiry. No-op if the token isn't found.
    pub fn renew_session(&self, token: &str, new_expires_at: SystemTime) -> Self {
        Self {
            sessions: self
                .sessions
                .iter()
                .map(|s| {
                    if s.token == token {
                        Session {
                            expires_at: new_expires_at,
                            ..s.clone()
                        }
                    } else {
                        s.clone()
                    }
                })
                .collect(),
            ..self.clone()
        }
    }

    /// Add or replace a setup token by id.
    pub fn add_setup_token(&self, token: SetupToken) -> Self {
        let mut setup_tokens: Vec<SetupToken> = self
            .setup_tokens
            .iter()
            .filter(|t| t.id != token.id)
            .cloned()
            .collect();
        setup_tokens.push(token);
        Self {
            setup_tokens,
            ..self.clone()
        }
    }

    /// Revoke a setup token. Cascades to remove the credential it paired (if
    /// any) and that credential's sessions — matches Node's
    /// "revoke token ⇒ remove device" flow (`7742ac3`). A token id that
    /// doesn't match anything is a no-op.
    pub fn remove_setup_token(&self, id: &str) -> Self {
        let doomed_credential_id = self
            .setup_tokens
            .iter()
            .find(|t| t.id == id)
            .and_then(|t| t.credential_id.clone());

        let setup_tokens: Vec<SetupToken> = self
            .setup_tokens
            .iter()
            .filter(|t| t.id != id)
            .cloned()
            .collect();

        match doomed_credential_id {
            Some(cid) => Self {
                setup_tokens,
                ..self.remove_credential(&cid)
            },
            None => Self {
                setup_tokens,
                ..self.clone()
            },
        }
    }

    /// Stamp a setup token as used by `credential_id` at `now`. No-op if the
    /// id isn't found. Idempotent: re-consuming doesn't rewrite `used_at`
    /// (preserves the original consumption time for audit).
    pub fn consume_setup_token(&self, id: &str, credential_id: &str, now: SystemTime) -> Self {
        Self {
            setup_tokens: self
                .setup_tokens
                .iter()
                .map(|t| {
                    if t.id == id && t.used_at.is_none() {
                        SetupToken {
                            used_at: Some(now),
                            credential_id: Some(credential_id.to_string()),
                            ..t.clone()
                        }
                    } else {
                        t.clone()
                    }
                })
                .collect(),
            ..self.clone()
        }
    }

    /// Drop setup tokens whose `expires_at` is at or before `now`. Consumed
    /// tokens stay — they're the audit trail for "device X was paired via
    /// token Y at time Z" and cost nothing to keep around.
    pub fn prune_expired_setup_tokens(&self, now: SystemTime) -> Self {
        Self {
            setup_tokens: self
                .setup_tokens
                .iter()
                .filter(|t| t.is_consumed() || now < t.expires_at)
                .cloned()
                .collect(),
            ..self.clone()
        }
    }
}

/// SystemTime <-> JSON helper: u64 milliseconds since UNIX_EPOCH.
///
/// JSON has no native timestamp type. Millis fit in u64 for ~584 million
/// years past 1970, which is plenty, and every JSON parser handles u64
/// integers cleanly. We deliberately don't use RFC 3339 strings: they're
/// bigger on disk, slower to parse, and invite timezone confusion where
/// none exists.
pub(crate) mod systime {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub fn serialize<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
        let millis = t
            .duration_since(UNIX_EPOCH)
            .map_err(|e| serde::ser::Error::custom(format!("timestamp before UNIX_EPOCH: {e}")))?
            .as_millis() as u64;
        s.serialize_u64(millis)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<SystemTime, D::Error> {
        let millis = u64::deserialize(d)?;
        Ok(UNIX_EPOCH + Duration::from_millis(millis))
    }
}

/// `Option<SystemTime>` variant — `None` serializes as `null`.
pub(crate) mod systime_opt {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub fn serialize<S: Serializer>(t: &Option<SystemTime>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            None => s.serialize_none(),
            Some(t) => {
                let millis = t
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| {
                        serde::ser::Error::custom(format!("timestamp before UNIX_EPOCH: {e}"))
                    })?
                    .as_millis() as u64;
                s.serialize_some(&millis)
            }
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<SystemTime>, D::Error> {
        let millis = Option::<u64>::deserialize(d)?;
        Ok(millis.map(|m| UNIX_EPOCH + Duration::from_millis(m)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn epoch_plus(ms: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_millis(ms)
    }

    fn cred(id: &str) -> Credential {
        Credential {
            id: id.into(),
            public_key: vec![1, 2, 3],
            name: None,
            counter: 0,
            created_at: epoch_plus(0),
            setup_token_id: None,
        }
    }

    fn sess(token: &str, cred_id: &str, expires_ms: u64) -> Session {
        Session {
            token: token.into(),
            credential_id: cred_id.into(),
            csrf_token: "csrf".into(),
            created_at: epoch_plus(0),
            expires_at: epoch_plus(expires_ms),
            last_activity_at: epoch_plus(0),
        }
    }

    #[test]
    fn new_state_is_empty() {
        let s = AuthState::new();
        assert!(s.credentials.is_empty());
        assert!(s.sessions.is_empty());
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn upsert_credential_replaces_by_id() {
        let mut c1 = cred("a");
        c1.counter = 1;
        let mut c2 = cred("a");
        c2.counter = 2;
        let s = AuthState::new().upsert_credential(c1).upsert_credential(c2);
        assert_eq!(s.credentials.len(), 1);
        assert_eq!(s.find_credential("a").unwrap().counter, 2);
    }

    #[test]
    fn remove_credential_cascades_to_sessions() {
        let s = AuthState::new()
            .upsert_credential(cred("a"))
            .upsert_credential(cred("b"))
            .add_session(sess("t1", "a", 1000))
            .add_session(sess("t2", "b", 1000))
            .remove_credential("a");
        assert!(s.find_credential("a").is_none());
        assert!(s.find_credential("b").is_some());
        assert!(s.find_session("t1").is_none());
        assert!(s.find_session("t2").is_some());
    }

    #[test]
    fn transitions_do_not_mutate_receiver() {
        let before = AuthState::new().upsert_credential(cred("a"));
        let after = before.remove_credential("a");
        assert_eq!(before.credentials.len(), 1);
        assert_eq!(after.credentials.len(), 0);
    }

    #[test]
    fn valid_session_rejects_expired() {
        let s = AuthState::new().add_session(sess("t", "a", 500));
        assert!(s.valid_session("t", epoch_plus(499)).is_some());
        assert!(s.valid_session("t", epoch_plus(500)).is_none());
        assert!(s.valid_session("t", epoch_plus(501)).is_none());
    }

    #[test]
    fn prune_expired_drops_only_expired() {
        let s = AuthState::new()
            .add_session(sess("live", "a", 1000))
            .add_session(sess("dead", "a", 500))
            .prune_expired(epoch_plus(700));
        assert!(s.find_session("live").is_some());
        assert!(s.find_session("dead").is_none());
    }

    #[test]
    fn touch_session_updates_only_target() {
        let s = AuthState::new()
            .add_session(sess("target", "a", 1000))
            .add_session(sess("other", "a", 1000))
            .touch_session("target", epoch_plus(500));
        assert_eq!(
            s.find_session("target").unwrap().last_activity_at,
            epoch_plus(500)
        );
        assert_eq!(
            s.find_session("other").unwrap().last_activity_at,
            epoch_plus(0)
        );
    }

    #[test]
    fn renew_session_extends_expiry() {
        let s = AuthState::new()
            .add_session(sess("t", "a", 500))
            .renew_session("t", epoch_plus(2000));
        assert_eq!(s.find_session("t").unwrap().expires_at, epoch_plus(2000));
    }

    #[test]
    fn add_session_replaces_same_token() {
        let s = AuthState::new()
            .add_session(sess("t", "a", 500))
            .add_session(sess("t", "a", 1500));
        assert_eq!(s.sessions.len(), 1);
        assert_eq!(s.find_session("t").unwrap().expires_at, epoch_plus(1500));
    }

    #[test]
    fn serde_round_trip() {
        let s = AuthState::new()
            .upsert_credential(cred("a"))
            .add_session(sess("t", "a", 1000));
        let json = serde_json::to_string(&s).unwrap();
        let back: AuthState = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn missing_fields_deserialize_to_defaults() {
        let raw = r#"{"schema_version":1}"#;
        let s: AuthState = serde_json::from_str(raw).unwrap();
        assert!(s.credentials.is_empty());
        assert!(s.sessions.is_empty());
        assert!(s.setup_tokens.is_empty());
    }

    // ---------- Setup tokens ----------

    fn issue_token(now_ms: u64, ttl_ms: u64) -> (String, crate::SetupToken) {
        crate::SetupToken::issue(None, epoch_plus(now_ms), Duration::from_millis(ttl_ms))
            .expect("issue failed")
    }

    #[test]
    fn add_setup_token_replaces_by_id() {
        let (_, t1) = issue_token(0, 1000);
        let mut t2 = t1.clone();
        t2.name = Some("renamed".into());
        let s = AuthState::new().add_setup_token(t1).add_setup_token(t2);
        assert_eq!(s.setup_tokens.len(), 1);
        assert_eq!(s.setup_tokens[0].name.as_deref(), Some("renamed"));
    }

    #[test]
    fn find_redeemable_setup_token_rejects_expired_and_consumed() {
        let (plain_live, live) = issue_token(0, 1000);
        let (plain_dead, dead) = issue_token(0, 100);
        let (plain_used, used) = issue_token(0, 1000);

        let s = AuthState::new()
            .add_setup_token(live)
            .add_setup_token(dead)
            .add_setup_token(used.clone())
            .consume_setup_token(&used.id, "some-cred", epoch_plus(50));

        let now = epoch_plus(500);
        assert!(s.find_redeemable_setup_token(&plain_live, now).is_some());
        assert!(s.find_redeemable_setup_token(&plain_dead, now).is_none());
        assert!(s.find_redeemable_setup_token(&plain_used, now).is_none());
        assert!(s.find_redeemable_setup_token("nope", now).is_none());
    }

    #[test]
    fn consume_setup_token_stamps_fields_and_is_idempotent() {
        let (_, t) = issue_token(0, 1000);
        let id = t.id.clone();
        let s =
            AuthState::new()
                .add_setup_token(t)
                .consume_setup_token(&id, "cred-1", epoch_plus(500));
        let consumed = s.find_setup_token(&id).unwrap();
        assert_eq!(consumed.used_at, Some(epoch_plus(500)));
        assert_eq!(consumed.credential_id.as_deref(), Some("cred-1"));

        // A second consume must not rewrite used_at — preserves the original
        // consumption time for audit.
        let s = s.consume_setup_token(&id, "cred-2", epoch_plus(900));
        let again = s.find_setup_token(&id).unwrap();
        assert_eq!(again.used_at, Some(epoch_plus(500)));
        assert_eq!(again.credential_id.as_deref(), Some("cred-1"));
    }

    #[test]
    fn remove_setup_token_cascades_to_paired_device() {
        let (_, t) = issue_token(0, 1000);
        let id = t.id.clone();
        let s = AuthState::new()
            .upsert_credential(cred("c1"))
            .upsert_credential(cred("c2"))
            .add_session(sess("t1", "c1", 1000))
            .add_session(sess("t2", "c2", 1000))
            .add_setup_token(t)
            .consume_setup_token(&id, "c1", epoch_plus(10))
            .remove_setup_token(&id);

        assert!(s.find_setup_token(&id).is_none());
        assert!(s.find_credential("c1").is_none(), "paired device removed");
        assert!(s.find_credential("c2").is_some(), "unrelated device kept");
        assert!(
            s.find_session("t1").is_none(),
            "paired device's session dropped"
        );
        assert!(s.find_session("t2").is_some());
    }

    #[test]
    fn remove_setup_token_without_credential_link_is_scoped() {
        let (_, t) = issue_token(0, 1000);
        let id = t.id.clone();
        let s = AuthState::new()
            .upsert_credential(cred("c1"))
            .add_setup_token(t)
            .remove_setup_token(&id);
        assert!(s.find_setup_token(&id).is_none());
        assert!(s.find_credential("c1").is_some());
    }

    #[test]
    fn prune_expired_setup_tokens_keeps_consumed() {
        let (_, live) = issue_token(0, 1000);
        let (_, dead_unused) = issue_token(0, 100);
        let (_, dead_but_consumed) = issue_token(0, 100);

        let consumed_id = dead_but_consumed.id.clone();
        let s = AuthState::new()
            .add_setup_token(live)
            .add_setup_token(dead_unused)
            .add_setup_token(dead_but_consumed)
            .consume_setup_token(&consumed_id, "c", epoch_plus(50))
            .prune_expired_setup_tokens(epoch_plus(500));

        assert_eq!(
            s.setup_tokens.len(),
            2,
            "unused+expired pruned, live and consumed kept"
        );
        assert!(s.find_setup_token(&consumed_id).is_some());
    }

    #[test]
    fn setup_tokens_round_trip_through_json() {
        let (plaintext, t) = issue_token(10, 1000);
        let state = AuthState::new().add_setup_token(t);
        let json = serde_json::to_string(&state).unwrap();
        let back: AuthState = serde_json::from_str(&json).unwrap();
        assert_eq!(state, back);
        // Verify still works after the round-trip — the PHC hash survives.
        assert!(back
            .find_redeemable_setup_token(&plaintext, epoch_plus(500))
            .is_some());
    }
}
