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
pub use session::Session;
pub use setup_token::{PlaintextToken, SetupToken};
pub use state::AuthState;
pub use store::AuthStore;
pub use webauthn::{ChallengeId, VerifiedAuthentication, WebAuthnService};

pub type Result<T> = std::result::Result<T, AuthError>;
