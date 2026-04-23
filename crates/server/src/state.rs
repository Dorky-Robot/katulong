//! Application state shared across request handlers.
//!
//! Constructed once at startup, cloned into every request extractor as
//! an `Arc`-wrapped struct. The inner fields carry their own `Arc`/
//! mutex discipline — `AuthStore` serialises writes through its own
//! mutex, `WebAuthnService` holds its in-memory challenge maps behind
//! their own mutexes. `AppState` itself is just a bundle of references.

use crate::revocation::RevocationPublisher;
use crate::session::{OutputRouter, SessionManager};
use katulong_auth::{AuthStore, WebAuthnService};
use std::sync::Arc;
use tokio::sync::broadcast::Receiver;

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
    /// Publishes credential-revocation events to every long-lived
    /// transport (WS, future WebRTC peer-links). Handlers call
    /// `state.revocations.emit(...)` after a successful revoke;
    /// subscribers call `state.subscribe_revocations()` at the
    /// start of their connection loop.
    pub revocations: RevocationPublisher,
    /// Handle to the terminal session layer. `None` in tests that
    /// don't need a real tmux subprocess (auth-only routes); `Some`
    /// when `main.rs` has successfully spawned tmux at startup.
    ///
    /// The session handler (`session::handler::serve_session`)
    /// surfaces a `no_session_manager` protocol error if a client
    /// tries to `Attach` when this is `None`. That's a clear
    /// misconfiguration signal rather than a silent hang — keeping
    /// the field `Option` rather than `Arc<SessionManager>` avoids
    /// forcing every auth integration test to stand up tmux.
    pub sessions: Option<Arc<SessionManager>>,
    /// Output-fan-out router. Always present (it's cheap — an
    /// `Arc<Mutex<HashMap>>` behind the clone) so handlers can
    /// always call `subscribe`. In `None`-sessions test builds
    /// it has no dispatcher populating it and every subscribe
    /// yields an empty stream; in production the dispatcher task
    /// spawned in `main.rs` feeds decoded tmux `%output` through
    /// it. Kept outside the `Option<SessionManager>` field
    /// deliberately: slice 9h's ring-buffer + reconnect-replay
    /// will want the router alive across session-manager
    /// restarts (if that ever becomes possible), and coupling
    /// the two by wrapping them in one `Option` would force a
    /// lifetime they don't share.
    pub output_router: OutputRouter,
}

impl AppState {
    /// Construct an `AppState` with no session manager. Suitable for
    /// tests that exercise auth/HTTP paths only. Production startup
    /// in `main.rs` chains `.with_sessions(...)` on top.
    pub fn new(auth_store: AuthStore, webauthn: WebAuthnService, config: ServerConfig) -> Self {
        Self {
            auth_store: Arc::new(auth_store),
            webauthn: Arc::new(webauthn),
            config: Arc::new(config),
            revocations: RevocationPublisher::new(),
            sessions: None,
            output_router: OutputRouter::new(),
        }
    }

    /// Attach a running `SessionManager` to this state. Called once
    /// at startup from `main.rs` after tmux spawns successfully.
    /// Moving rather than cloning reinforces "there's one session
    /// layer per server process."
    pub fn with_sessions(mut self, sessions: SessionManager) -> Self {
        self.sessions = Some(Arc::new(sessions));
        self
    }

    /// Override the default-constructed `OutputRouter` with the
    /// one fed by the tmux dispatcher task. `AppState::new`
    /// constructs an empty router so tests that never wire tmux
    /// can still call `.subscribe` on it (and get an empty
    /// stream); production startup replaces it with the router
    /// whose clone is handed to the dispatcher task.
    ///
    /// The two-step "default + override" shape matches
    /// `with_sessions`; using struct-update syntax at the call
    /// site works but silently throws away the default router
    /// allocation, which an architecture review round flagged
    /// as a latent surprise ("new() promises a valid state
    /// then callers stomp one field").
    pub fn with_output_router(mut self, router: OutputRouter) -> Self {
        self.output_router = router;
        self
    }

    /// Subscribe to credential-revocation events. Transport-agnostic
    /// — the returned receiver delivers the same events to a WS
    /// handler or a future WebRTC peer connection. Subscribers
    /// compare each event's `credential_id` to the credential their
    /// connection is bound to and tear down on match.
    pub fn subscribe_revocations(&self) -> Receiver<crate::revocation::RevocationEvent> {
        self.revocations.subscribe()
    }
}
