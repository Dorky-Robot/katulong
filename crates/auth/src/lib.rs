//! Katulong authentication state.
//!
//! Functional-core / imperative-shell split: `AuthState` is an immutable value
//! type with pure transitions (`&self -> Self`); `AuthStore` is the thin
//! imperative boundary that serializes concurrent mutations through a single
//! mutex and persists via atomic temp+rename.
//!
//! Deviates from the Node implementation on one deliberate point: session
//! token hashing parameters are serialized alongside each hash (PHC-style),
//! so changing params later requires only a version bump, not a migration
//! that locks out existing credentials (see commit `be5826b` in Node for the
//! scar this avoids).

mod credential;
mod error;
mod random;
mod session;
mod setup_token;
mod state;
mod store;
mod webauthn;

pub use credential::Credential;
pub use error::AuthError;
pub use session::{Session, SESSION_TTL};
pub use setup_token::{PlaintextToken, SetupToken};
pub use state::AuthState;
pub use store::AuthStore;
pub use webauthn::{ChallengeId, VerifiedAuthentication, WebAuthnService};

/// Re-export the webauthn-rs wire types the server crate needs to shape
/// its HTTP request/response bodies. Keeping these behind the auth
/// crate's facade means the server crate doesn't grow a direct
/// dependency on `webauthn-rs` — if we ever swap the underlying library,
/// the surface that changes is this file, not every handler.
pub mod webauthn_wire {
    pub use webauthn_rs::prelude::{
        CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
        RequestChallengeResponse,
    };
}

pub type Result<T> = std::result::Result<T, AuthError>;
