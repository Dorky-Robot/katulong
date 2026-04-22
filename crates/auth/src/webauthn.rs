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

use crate::{AuthError, Credential, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use std::collections::HashMap;
use std::fmt::Write as _;
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

/// Opaque handle returned to the client after `start_*`. The client passes it
/// back on `finish_*` so we can look up the corresponding webauthn-rs state.
/// 16 random bytes, hex-encoded (32 chars).
pub type ChallengeId = String;

/// Materialised outcome of `finish_authentication`: the caller is expected
/// to persist the counter update via `AuthStore::transact` and then mint a
/// session.
#[derive(Debug, Clone)]
pub struct AuthenticationOutcome {
    pub credential_id: String,
    pub new_counter: u32,
    pub user_verified: bool,
}

pub struct WebAuthnCeremony {
    webauthn: Webauthn,
    pending_registrations: Mutex<HashMap<ChallengeId, (PasskeyRegistration, SystemTime)>>,
    pending_authentications: Mutex<HashMap<ChallengeId, (PasskeyAuthentication, SystemTime)>>,
}

impl WebAuthnCeremony {
    /// Build a ceremony bound to a specific RP ID + origin. `rp_name` is the
    /// human-readable string that shows up in the browser's passkey dialogue.
    pub fn new(rp_id: &str, rp_name: &str, origin: &str) -> Result<Self> {
        let origin_url =
            Url::parse(origin).map_err(|e| AuthError::WebAuthn(format!("bad origin: {e}")))?;
        let webauthn = WebauthnBuilder::new(rp_id, &origin_url)
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?
            .rp_name(rp_name)
            .build()
            .map_err(|e| AuthError::WebAuthn(e.to_string()))?;
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
        self.pending_registrations
            .lock()
            .expect("challenge store mutex poisoned")
            .insert(id.clone(), (reg_state, now + CHALLENGE_TTL));
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
        // `AuthenticationOutcome.new_counter` on each subsequent login.
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
        self.pending_authentications
            .lock()
            .expect("challenge store mutex poisoned")
            .insert(id.clone(), (auth_state, now + CHALLENGE_TTL));
        Ok((id, rcr))
    }

    /// Finish an authentication ceremony. Caller must persist the returned
    /// counter update — a signature counter regressing is webauthn-rs's
    /// signal that the credential has been cloned (or replayed from an
    /// older interaction) and further use should be refused.
    pub fn finish_authentication(
        &self,
        challenge_id: &str,
        response: &PublicKeyCredential,
        now: SystemTime,
    ) -> Result<AuthenticationOutcome> {
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

        Ok(AuthenticationOutcome {
            credential_id: encode_credential_id(result.cred_id()),
            new_counter: result.counter(),
            user_verified: result.user_verified(),
        })
    }

    /// Drop challenges whose TTL has elapsed. Cheap to call periodically.
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

    /// Produce the JSON bytes representing a `Passkey` for a fresh
    /// `Credential`. Exposed for tests and for internal tooling that needs
    /// to reconstruct the full passkey from stored material.
    pub fn passkey_from_credential(cred: &Credential) -> Result<Passkey> {
        serde_json::from_slice(&cred.public_key).map_err(|e| AuthError::WebAuthn(e.to_string()))
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

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        write!(&mut out, "{b:02x}").expect("write to String cannot fail");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ceremony() -> WebAuthnCeremony {
        WebAuthnCeremony::new(
            "katulong.test",
            "katulong",
            "https://katulong.test",
        )
        .expect("ceremony should build with a well-formed origin")
    }

    // `WebAuthnCeremony` wraps `webauthn_rs::Webauthn`, which doesn't
    // implement `Debug`, so we can't `#[derive(Debug)]` on the ceremony and
    // therefore can't use `Result::unwrap_err` on `WebAuthnCeremony::new`'s
    // return. Pattern-match the error variant directly — same coverage,
    // doesn't require the Ok type to be printable.
    #[test]
    fn new_rejects_bad_origin() {
        let Err(err) = WebAuthnCeremony::new("katulong.test", "katulong", "not a url") else {
            panic!("expected WebAuthnCeremony::new to reject a non-URL origin");
        };
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    #[test]
    fn new_rejects_rp_mismatch() {
        // RP id must be a registrable domain suffix of the origin host.
        let Err(err) = WebAuthnCeremony::new("other.example", "x", "https://katulong.test")
        else {
            panic!("expected WebAuthnCeremony::new to reject an rp_id that doesn't suffix the origin host");
        };
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    #[test]
    fn start_registration_returns_unique_challenge_ids() {
        let svc = ceremony();
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
        let svc = ceremony();
        let fake = fake_register_response();
        let err = svc
            .finish_registration("nope", &fake, SystemTime::UNIX_EPOCH)
            .unwrap_err();
        assert!(matches!(err, AuthError::ChallengeNotFound));
    }

    #[test]
    fn finish_registration_rejects_expired_challenge() {
        let svc = ceremony();
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
        let svc = ceremony();
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
        let svc = ceremony();
        let err = svc.start_authentication(&[], SystemTime::UNIX_EPOCH).unwrap_err();
        assert!(matches!(err, AuthError::WebAuthn(_)));
    }

    #[test]
    fn start_authentication_filters_malformed_credentials() {
        // A stored row with non-JSON material must not poison the ceremony —
        // it just gets silently dropped from the allowCredentials list.
        // With no other credentials, that reduces to the empty-set error.
        let svc = ceremony();
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
        let svc = ceremony();
        let start = SystemTime::UNIX_EPOCH;
        let (_, _) = svc
            .start_registration(Uuid::new_v4(), "u", "U", &[], start)
            .unwrap();
        assert_eq!(svc.pending_registrations.lock().unwrap().len(), 1);
        svc.prune_expired_challenges(start + CHALLENGE_TTL + Duration::from_secs(1));
        assert_eq!(svc.pending_registrations.lock().unwrap().len(), 0);
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
