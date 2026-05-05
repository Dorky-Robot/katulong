use serde::{Deserialize, Serialize};
use std::time::SystemTime;

/// A registered WebAuthn credential (passkey).
///
/// Every credential in katulong is a platform-internal passkey — new devices
/// are paired via setup token or device-auth approval, not via WebAuthn's
/// cross-device (QR/hybrid) transport. That flow was removed in Node commit
/// `b79ff67` after it proved unreliable on real devices. So there's no
/// per-credential `transports` field: `allowCredentials` emits the constant
/// `["internal"]` when generating auth options.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Credential {
    pub id: String,
    pub public_key: Vec<u8>,
    pub name: Option<String>,
    pub counter: u32,
    #[serde(with = "crate::state::systime")]
    pub created_at: SystemTime,
    /// Link back to the setup token that paired this device, if any. Lets us
    /// show tokens as "unused" vs "paired device <name>" and cascade a
    /// token revocation into removing the device it created (Node scar:
    /// `7742ac3`, which added this bidirectional link after finding the
    /// cleanup logic unanswerable without it).
    #[serde(default)]
    pub setup_token_id: Option<String>,
    /// User-Agent string captured at register/pair time. Surfaced on the
    /// `/api/credentials` and `/api/tokens` device-management UI so the
    /// operator can match a passkey row to the device that minted it
    /// (a phone vs a laptop, Safari vs Chrome). Defaults to empty
    /// when missing so older state files load without a migration —
    /// matches Node's `userAgent || 'Unknown'` tolerance.
    #[serde(default)]
    pub user_agent: String,
    /// Wall-clock unix-millis of the last successful authentication
    /// against this credential. `None` until the credential is used at
    /// least once. Updated by `apply_authentication` so the same
    /// transition that bumps the WebAuthn counter also stamps usage —
    /// no second writer means no extra TOCTOU surface.
    #[serde(default, with = "crate::state::systime_opt")]
    pub last_used_at: Option<SystemTime>,
}
