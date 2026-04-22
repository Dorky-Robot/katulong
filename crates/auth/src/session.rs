use serde::{Deserialize, Serialize};
use std::time::SystemTime;

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
