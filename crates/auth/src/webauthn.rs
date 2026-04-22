//! WebAuthn registration and authentication ceremonies.
//!
//! Thin wrapper over `webauthn-rs` that owns the in-memory challenge store
//! between `start_*` and `finish_*` requests. Challenges are time-limited
//! and single-use: `finish_*` removes the entry before verifying, so a
//! replayed response against a valid challenge ID fails by missing state
//! rather than by re-verifying against a resident challenge.
//!
//! # RP ID and origin come from configuration
//!
//! WebAuthn binds credentials to the relying-party ID (hostname) and validates
//! assertions against the exact origin (`scheme://host:port`). Both must come
//! from operator-controlled configuration — NOT from request headers.
//!
//! This is a deliberate departure from the Node implementation, which
//! trusted `X-Forwarded-Proto` as a fallback for tunnel deployments
//! (`21045b2`). That tradeoff made sense when "we only trust it for
//! origin matching, the cryptographic assertion is the real auth gate," but
//! katulong's current posture is "never trust forwarded headers for anything
//! security-adjacent." In the Rust port we require the operator to set the
//! public origin at startup (likely the same URL the tunnel exposes); that
//! way spoofing `X-Forwarded-Proto` can't trick us into accepting assertions
//! from a different origin.
//!
//! # Registration vs login API asymmetry
//!
//! Platform-authenticator preference is expressed differently on the two
//! ceremonies. On registration we can steer the UI toward the platform
//! authenticator via `authenticatorAttachment: "platform"`; on login that
//! field doesn't exist, and the steering is done by `allowCredentials`
//! `transports: ["internal"]`. Node learned this the hard way in `9198b6e`.
//! webauthn-rs handles the registration side for us; on the login side
//! we pass only `Passkey` values we already stored, which encode the same
//! intent.

use crate::random::random_hex;
use crate::{AuthError, Credential, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use url::Url;
use uuid::Uuid;
use webauthn_rs::prelude::*;
use webauthn_rs::{Webauthn, WebauthnBuilder};

/// How long a generated challenge stays valid on the server. Five minutes
/// is comfortably longer than any real user would take to respond to a
/// biometric prompt, and short enough that a captured challenge ID can't
/// linger for an attacker to replay.
const CHALLENGE_TTL: Duration = Duration::from_secs(5 * 60);

/// Upper bound on the number of pending registration or authentication
/// challenges the service will track at once. Each `start_*` call
/// opportunistically prunes expired entries from its map; if the map is
/// STILL at the cap after pruning, further `start_*` calls surface
/// `TooManyPendingChallenges` rather than growing unbounded.
///
/// The number is deliberately generous — katulong is single-user, so 1024
/// concurrent pending ceremonies is already 3 orders of magnitude above
/// legitimate use. The cap exists purely to blunt an unauthenticated
/// attacker who holds open registration/auth starts without ever finishing,
/// which would otherwise consume memory until OOM.
const MAX_PENDING_CHALLENGES: usize = 1024;

/// Opaque handle returned to the client after `start_*`. The client passes it
/// back on `finish_*` so we can look up the corresponding webauthn-rs state.
/// 16 random bytes, hex-encoded (32 chars).
pub type ChallengeId = String;

/// Materialised outcome of `finish_authentication`.
///
/// `updated_credential` carries the `Passkey` blob rewritten with the
/// counter/backup-state update produced by the authenticator. The caller
/// MUST persist it via `AuthStore::transact(|s| Ok((s.upsert_credential(
/// updated), ())))` before minting a session — without that write, the
/// stored `public_key` blob's counter baseline never advances, and
/// webauthn-rs's clone-detection monotonicity check (which compares
/// incoming counters against the baseline INSIDE the stored blob) is
/// silently inert for every subsequent login. `None` means the
/// authenticator reported no change and the blob does not need to be
/// rewritten (e.g., counterless synced passkeys with identical backup
/// state) — this is the `Passkey::update_credential` returning
/// `Some(false)` case, not an error.
///
/// `#[must_use]` applies to the whole struct: forgetting to inspect
/// `updated_credential` silently reopens the clone-detection gap this
/// slice was built to close, so the compiler should warn if the whole
/// value is dropped without a match.
#[must_use = "updated_credential must be persisted via AuthStore or webauthn-rs clone-detection is inert"]
#[derive(Debug, Clone)]
pub struct VerifiedAuthentication {
    pub credential_id: String,
    pub new_counter: u32,
    pub user_verified: bool,
    pub updated_credential: Option<Credential>,
}

/// Long-lived WebAuthn ceremony coordinator.
///
/// Construct ONCE at application startup and share via `Arc<WebAuthnService>`
/// across all request handlers — `start_*` and `finish_*` for the same
/// ceremony must observe the same in-memory challenge store, so
/// reconstructing per-request would silently drop every pending challenge.
/// Named `*Service` rather than `*Ceremony` because in the WebAuthn spec a
/// "ceremony" is a single exchange; this struct is the coordinator, not the
/// exchange.
pub struct WebAuthnService {
    webauthn: Webauthn,
    pending_registrations: Mutex<HashMap<ChallengeId, (PasskeyRegistration, SystemTime)>>,
    pending_authentications: Mutex<HashMap<ChallengeId, (PasskeyAuthentication, SystemTime)>>,
}

impl WebAuthnService {
    /// Build a service bound to a specific RP ID + origin. `rp_name` is the
    /// human-readable string that shows up in the browser's passkey dialogue.
    ///
    /// Intended to be called once at startup; share the result via `Arc`
    /// across request handlers so pending challenges persist between
    /// `start_*` and `finish_*` calls on the same ceremony.
    pub fn new(rp_id: &str, rp_name: &str, origin: &str) -> Result<Self> {
        let origin_url = Url::parse(origin)
            .map_err(|e| AuthError::WebAuthnConfig(format!("bad origin: {e}")))?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin_url)
            .map_err(|e| AuthError::WebAuthnConfig(e.to_string()))?
            .rp_name(rp_name)
            .build()
            .map_err(|e| AuthError::WebAuthnConfig(e.to_string()))?;
        Ok(Self {
            webauthn,
            pending_registrations: Mutex::new(HashMap::new()),
            pending_authentications: Mutex::new(HashMap::new()),
        })
    }

    /// Start a registration ceremony. `existing` is the current list of
    /// credentials so the browser can reject re-registration of the same
    /// authenticator via `excludeCredentials`.
    ///
    /// Malformed stored credential IDs are filtered out rather than causing
    /// the whole ceremony to abort — one bad row shouldn't poison
    /// registration for the rest of the instance (Node scar: `2d73b6c`).
    pub fn start_registration(
        &self,
        user_unique_id: Uuid,
        user_name: &str,
        user_display_name: &str,
        existing: &[Credential],
        now: SystemTime,
    ) -> Result<(ChallengeId, CreationChallengeResponse)> {
        let exclude: Vec<CredentialID> = existing
            .iter()
            .filter_map(|c| decode_credential_id(&c.id).ok())
            .collect();
        let exclude = (!exclude.is_empty()).then_some(exclude);

        let (ccr, reg_state) = self
            .webauthn
            .start_passkey_registration(user_unique_id, user_name, user_display_name, exclude)
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?;

        let id = random_hex(16);
        insert_pending(
            &self.pending_registrations,
            id.clone(),
            reg_state,
            now + CHALLENGE_TTL,
            now,
        )?;
        Ok((id, ccr))
    }

    /// Finish a registration ceremony, producing a `Credential` ready to be
    /// inserted into the store. The challenge is consumed regardless of
    /// success — a verify failure must not leave the challenge in the map
    /// for the attacker to try again.
    pub fn finish_registration(
        &self,
        challenge_id: &str,
        response: &RegisterPublicKeyCredential,
        now: SystemTime,
    ) -> Result<Credential> {
        let (reg_state, expires_at) = self
            .pending_registrations
            .lock()
            .expect("challenge store mutex poisoned")
            .remove(challenge_id)
            .ok_or(AuthError::ChallengeNotFound)?;
        if now >= expires_at {
            return Err(AuthError::ChallengeNotFound);
        }

        let passkey = self
            .webauthn
            .finish_passkey_registration(response, &reg_state)
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?;

        let id = encode_credential_id(passkey.cred_id());
        let material =
            serde_json::to_vec(&passkey).map_err(|e| AuthError::WebAuthn(e.to_string()))?;

        // webauthn-rs's public `Passkey` API deliberately hides the signature
        // counter (only `cred_id`, `cred_algorithm`, `get_public_key`, and
        // `update_credential` are exposed). The authoritative counter lives
        // inside the serialized `Passkey` blob in `public_key` — webauthn-rs
        // unpacks it on every `finish_passkey_authentication` and enforces
        // monotonicity there (clone-detection happens inside the library,
        // not against our field). Our `Credential.counter` is a display/audit
        // echo: start at 0 and keep it in sync via
        // `VerifiedAuthentication.new_counter` on each subsequent login.
        //
        // Reaching into `Passkey` via the `danger-credential-internals`
        // feature was considered and rejected — the feature name is a flag,
        // and the only win would be echoing a (usually-zero) initial value a
        // few seconds earlier than the first successful auth would update it.
        Ok(Credential {
            id,
            public_key: material,
            name: None,
            counter: 0,
            created_at: now,
            setup_token_id: None,
        })
    }

    /// Start an authentication ceremony. `credentials` is the server's
    /// complete set of registered credentials (we iterate them all since
    /// katulong is single-user and credential count is tiny); webauthn-rs
    /// builds `allowCredentials` from the embedded passkey payload, which
    /// already carries the correct transports.
    ///
    /// Returns an error if there are no parseable credentials — no point
    /// issuing a login challenge against nothing.
    pub fn start_authentication(
        &self,
        credentials: &[Credential],
        now: SystemTime,
    ) -> Result<(ChallengeId, RequestChallengeResponse)> {
        let passkeys: Vec<Passkey> = credentials
            .iter()
            .filter_map(|c| serde_json::from_slice(&c.public_key).ok())
            .collect();
        if passkeys.is_empty() {
            return Err(AuthError::WebAuthn(
                "no usable credentials registered".into(),
            ));
        }

        let (rcr, auth_state) = self
            .webauthn
            .start_passkey_authentication(&passkeys)
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?;

        let id = random_hex(16);
        insert_pending(
            &self.pending_authentications,
            id.clone(),
            auth_state,
            now + CHALLENGE_TTL,
            now,
        )?;
        Ok((id, rcr))
    }

    /// Finish an authentication ceremony.
    ///
    /// Takes the caller's current credential set so we can look up the
    /// stored `Passkey` by its cred-id, apply the counter/backup-state
    /// update from the authenticator's assertion, and hand the refreshed
    /// `Credential` back for the caller to persist. Without this refresh,
    /// webauthn-rs's clone-detection baseline (stored inside the serialized
    /// `Passkey` blob) never advances and monotonicity enforcement is
    /// inert on every login after the first — a cloned authenticator could
    /// then replay indefinitely.
    ///
    /// `updated_credential` is `None` when `Passkey::update_credential`
    /// reports no change (counterless synced passkeys with matching backup
    /// state are the common case) — the caller can then skip the write.
    pub fn finish_authentication(
        &self,
        challenge_id: &str,
        response: &PublicKeyCredential,
        credentials: &[Credential],
        now: SystemTime,
    ) -> Result<VerifiedAuthentication> {
        let (auth_state, expires_at) = self
            .pending_authentications
            .lock()
            .expect("challenge store mutex poisoned")
            .remove(challenge_id)
            .ok_or(AuthError::ChallengeNotFound)?;
        if now >= expires_at {
            return Err(AuthError::ChallengeNotFound);
        }

        let result = self
            .webauthn
            .finish_passkey_authentication(response, &auth_state)
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?;

        let credential_id = encode_credential_id(result.cred_id());
        let new_counter = result.counter();
        let user_verified = result.user_verified();

        // The stored credential must still exist for the assertion to be
        // meaningful: `start_authentication` captured it in `auth_state`, and
        // an admin revocation during the 5-minute challenge window (or any
        // other deletion) means the passkey has been explicitly disallowed.
        // Letting the ceremony succeed anyway would defeat revocation — the
        // caller would mint a session against a credential the admin
        // already pulled. Fail closed.
        let cred = credentials
            .iter()
            .find(|c| c.id == credential_id)
            .ok_or_else(|| {
                AuthError::WebAuthn(
                    "credential revoked or missing after successful ceremony".into(),
                )
            })?;
        let updated_credential = apply_auth_result(cred, &result)?;

        Ok(VerifiedAuthentication {
            credential_id,
            new_counter,
            user_verified,
            updated_credential,
        })
    }

    /// Drop challenges whose TTL has elapsed. Cheap to call periodically.
    /// The HTTP / server layer is expected to schedule this (e.g. every
    /// minute via `tokio::time::interval`); `start_*` also runs an
    /// opportunistic prune before the capacity check to keep the maps from
    /// filling up between scheduled sweeps.
    pub fn prune_expired_challenges(&self, now: SystemTime) {
        self.pending_registrations
            .lock()
            .expect("challenge store mutex poisoned")
            .retain(|_, (_, exp)| now < *exp);
        self.pending_authentications
            .lock()
            .expect("challenge store mutex poisoned")
            .retain(|_, (_, exp)| now < *exp);
    }
}

/// Apply a WebAuthn authentication assertion to the stored `Passkey`
/// blob and return the resulting `Credential` if anything changed.
///
/// `None` means the authenticator reported no counter / backup-state
/// delta (common for counterless synced passkeys), so the caller should
/// skip the write. `Some(updated)` means the `Passkey` advanced and the
/// caller must upsert — failing to persist leaves clone-detection stuck
/// at the previous baseline.
fn apply_auth_result(
    cred: &Credential,
    result: &AuthenticationResult,
) -> Result<Option<Credential>> {
    let mut passkey = cred.to_passkey()?;
    match passkey.update_credential(result) {
        Some(true) => {
            let material =
                serde_json::to_vec(&passkey).map_err(|e| AuthError::WebAuthn(e.to_string()))?;
            Ok(Some(Credential {
                public_key: material,
                counter: result.counter(),
                ..cred.clone()
            }))
        }
        // Cred id matched, nothing to update — counterless synced passkey
        // with identical backup state. Safe no-op.
        Some(false) => Ok(None),
        // Cred id inside the blob doesn't match the result's cred id.
        // The caller already looked up `cred` by the result's encoded
        // cred id, so this means the stored blob disagrees with its
        // own row — a data-integrity corruption. Fail loudly rather
        // than silently skipping the counter update, because collapsing
        // this into `Ok(None)` would leave clone-detection permanently
        // inert for that credential with no operator-visible signal.
        None => Err(AuthError::WebAuthn(
            "credential blob cred_id mismatch; refusing to skip counter update".into(),
        )),
    }
}

/// Insert `(value, expires_at)` at `id`, first pruning expired entries
/// and then refusing if the map is still at `MAX_PENDING_CHALLENGES`.
/// The prune runs before the cap check so an organic build-up of stale
/// entries doesn't lock out legitimate starts.
fn insert_pending<T>(
    store: &Mutex<HashMap<ChallengeId, (T, SystemTime)>>,
    id: ChallengeId,
    value: T,
    expires_at: SystemTime,
    now: SystemTime,
) -> Result<()> {
    let mut guard = store.lock().expect("challenge store mutex poisoned");
    guard.retain(|_, (_, exp)| now < *exp);
    if guard.len() >= MAX_PENDING_CHALLENGES {
        return Err(AuthError::TooManyPendingChallenges);
    }
    guard.insert(id, (value, expires_at));
    Ok(())
}

impl Credential {
    /// Deserialize the stored `Passkey` blob.
    ///
    /// Lives on `Credential` rather than `WebAuthnService` because the
    /// conversion is pure value-to-value and has no relationship to
    /// ceremony state — a caller with just a `Credential` shouldn't need
    /// to hold the service to read its own blob.
    pub fn to_passkey(&self) -> Result<Passkey> {
        serde_json::from_slice(&self.public_key).map_err(|e| AuthError::WebAuthn(e.to_string()))
    }
}

fn encode_credential_id(cred_id: &CredentialID) -> String {
    URL_SAFE_NO_PAD.encode(cred_id.as_ref())
}

fn decode_credential_id(s: &str) -> Result<CredentialID> {
    let bytes = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| AuthError::WebAuthn(format!("credential id: {e}")))?;
    Ok(CredentialID::from(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> WebAuthnService {
        WebAuthnService::new("katulong.test", "katulong", "https://katulong.test")
            .expect("service should build with a well-formed origin")
    }

    // `WebAuthnService` wraps `webauthn_rs::Webauthn`, which doesn't
    // implement `Debug`, so we can't `#[derive(Debug)]` on the service and
    // therefore can't use `Result::unwrap_err` on `WebAuthnService::new`'s
    // return. Pattern-match the error variant directly — same coverage,
    // doesn't require the Ok type to be printable.
    #[test]
    fn new_rejects_bad_origin() {
        let Err(err) = WebAuthnService::new("katulong.test", "katulong", "not a url") else {
            panic!("expected WebAuthnService::new to reject a non-URL origin");
        };
        assert!(matches!(err, AuthError::WebAuthnConfig(_)));
    }

    #[test]
    fn new_rejects_rp_mismatch() {
        // RP id must be a registrable domain suffix of the origin host.
        let Err(err) = WebAuthnService::new("other.example", "x", "https://katulong.test") else {
            panic!("expected WebAuthnService::new to reject an rp_id that doesn't suffix the origin host");
        };
        assert!(matches!(err, AuthError::WebAuthnConfig(_)));
    }

    #[test]
    fn start_registration_returns_unique_challenge_ids() {
        let svc = service();
        let (id1, _) = svc
            .start_registration(
                Uuid::new_v4(),
                "felix",
                "Felix",
                &[],
                SystemTime::UNIX_EPOCH,
            )
            .unwrap();
        let (id2, _) = svc
            .start_registration(
                Uuid::new_v4(),
                "felix",
                "Felix",
                &[],
                SystemTime::UNIX_EPOCH,
            )
            .unwrap();
        assert_ne!(id1, id2);
        assert_eq!(id1.len(), 32);
    }

    #[test]
    fn finish_registration_rejects_unknown_challenge() {
        let svc = service();
        let fake = fake_register_response();
        let err = svc
            .finish_registration("nope", &fake, SystemTime::UNIX_EPOCH)
            .unwrap_err();
        assert!(matches!(err, AuthError::ChallengeNotFound));
    }

    #[test]
    fn finish_registration_rejects_expired_challenge() {
        let svc = service();
        let start = SystemTime::UNIX_EPOCH;
        let (id, _) = svc
            .start_registration(Uuid::new_v4(), "u", "U", &[], start)
            .unwrap();
        let fake = fake_register_response();
        let later = start + CHALLENGE_TTL + Duration::from_secs(1);
        let err = svc.finish_registration(&id, &fake, later).unwrap_err();
        assert!(matches!(err, AuthError::ChallengeNotFound));
    }

    #[test]
    fn finish_registration_consumes_challenge_on_failure() {
        // A bogus response must still burn the challenge — otherwise an
        // attacker could keep trying against the same server-side state.
        let svc = service();
        let start = SystemTime::UNIX_EPOCH;
        let (id, _) = svc
            .start_registration(Uuid::new_v4(), "u", "U", &[], start)
            .unwrap();
        let fake = fake_register_response();
        let _ = svc.finish_registration(&id, &fake, start);
        // Second attempt finds no state even with the same id.
        let err = svc.finish_registration(&id, &fake, start).unwrap_err();
        assert!(matches!(err, AuthError::ChallengeNotFound));
    }

    #[test]
    fn start_authentication_rejects_empty_credential_set() {
        let svc = service();
        let err = svc.start_authentication(&[], SystemTime::UNIX_EPOCH).unwrap_err();
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    #[test]
    fn start_authentication_filters_malformed_credentials() {
        // A stored row with non-JSON material must not poison the ceremony —
        // it just gets silently dropped from the allowCredentials list.
        // With no other credentials, that reduces to the empty-set error.
        let svc = service();
        let bad = Credential {
            id: "cred-bad".into(),
            public_key: b"not-json".to_vec(),
            name: None,
            counter: 0,
            created_at: SystemTime::UNIX_EPOCH,
            setup_token_id: None,
        };
        let err = svc
            .start_authentication(std::slice::from_ref(&bad), SystemTime::UNIX_EPOCH)
            .unwrap_err();
        // Empty after filter → "no usable credentials".
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    #[test]
    fn prune_expired_challenges_removes_stale_entries() {
        let svc = service();
        let start = SystemTime::UNIX_EPOCH;
        let (_, _) = svc
            .start_registration(Uuid::new_v4(), "u", "U", &[], start)
            .unwrap();
        assert_eq!(svc.pending_registrations.lock().unwrap().len(), 1);
        svc.prune_expired_challenges(start + CHALLENGE_TTL + Duration::from_secs(1));
        assert_eq!(svc.pending_registrations.lock().unwrap().len(), 0);
    }

    #[test]
    fn insert_pending_caps_the_map_after_pruning() {
        // Uses a bare `Mutex<HashMap<_, ((), SystemTime)>>` so we can
        // exercise the cap without needing real webauthn-rs state objects.
        let store: Mutex<HashMap<ChallengeId, ((), SystemTime)>> = Mutex::new(HashMap::new());
        let now = SystemTime::UNIX_EPOCH;
        let future = now + Duration::from_secs(600);

        // Fill to capacity with live entries.
        for i in 0..MAX_PENDING_CHALLENGES {
            insert_pending(&store, format!("k{i}"), (), future, now)
                .expect("fill to capacity should succeed");
        }

        // One more live entry should be rejected.
        let err = insert_pending(&store, "overflow".into(), (), future, now).unwrap_err();
        assert!(matches!(err, AuthError::TooManyPendingChallenges));

        // After the TTL has elapsed, stale entries prune on insert and
        // a new entry is accepted.
        let later = future + Duration::from_secs(1);
        insert_pending(&store, "after-prune".into(), (), later + Duration::from_secs(60), later)
            .expect("prune should reclaim space");
        let guard = store.lock().unwrap();
        assert_eq!(guard.len(), 1, "prune should have dropped expired entries");
        assert!(guard.contains_key("after-prune"));
    }

    #[test]
    fn credential_to_passkey_roundtrips_via_blob() {
        // Deserializing a hand-rolled non-JSON blob must fail cleanly with
        // a WebAuthn error, not panic.
        let bad = Credential {
            id: "x".into(),
            public_key: b"not-json".to_vec(),
            name: None,
            counter: 0,
            created_at: SystemTime::UNIX_EPOCH,
            setup_token_id: None,
        };
        let err = bad.to_passkey().unwrap_err();
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    fn fake_register_response() -> RegisterPublicKeyCredential {
        // Syntactically minimal, cryptographically invalid — enough to
        // exercise the challenge lifecycle without running real crypto.
        serde_json::from_str(
            r#"{
                "id": "AAAA",
                "rawId": "AAAA",
                "response": {
                    "clientDataJSON": "",
                    "attestationObject": ""
                },
                "type": "public-key",
                "extensions": {}
            }"#,
        )
        .expect("fake response should parse")
    }
}
