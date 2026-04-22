//! Application state shared across request handlers.
//!
//! Constructed once at startup, cloned into every request extractor as
//! an `Arc`-wrapped struct. The inner fields carry their own `Arc`/
//! mutex discipline — `AuthStore` serialises writes through its own
//! mutex, `WebAuthnService` holds its in-memory challenge maps behind
//! their own mutexes. `AppState` itself is just a bundle of references.

use katulong_auth::{AuthStore, WebAuthnService};
use std::sync::Arc;

/// Operator-supplied configuration captured at startup.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Public origin (`https://katulong.example`) used for WebAuthn
    /// assertion matching. MUST come from operator config, not from
    /// request headers — trusting `X-Forwarded-Proto` here is exactly
    /// the bug the Node port worked around by accident.
    pub public_origin: String,
    /// Relying-party ID (the hostname portion of `public_origin`).
    pub rp_id: String,
    /// Human-readable RP name shown in the browser's passkey picker.
    pub rp_name: String,
    /// Whether remote cookies should carry the `Secure` flag. True for
    /// tunnel/TLS deployments, false for plain-http dev over loopback.
    pub cookie_secure: bool,
}

/// The handle threaded through every handler and extractor.
///
/// Cheap to clone — `Arc` bumps a refcount. The bindings on the inner
/// fields are all cloneable references to the same underlying state.
#[derive(Clone)]
pub struct AppState {
    pub auth_store: Arc<AuthStore>,
    pub webauthn: Arc<WebAuthnService>,
    pub config: Arc<ServerConfig>,
}

impl AppState {
    pub fn new(auth_store: AuthStore, webauthn: WebAuthnService, config: ServerConfig) -> Self {
        Self {
            auth_store: Arc::new(auth_store),
            webauthn: Arc::new(webauthn),
            config: Arc::new(config),
        }
    }
}
