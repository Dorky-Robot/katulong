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
}
