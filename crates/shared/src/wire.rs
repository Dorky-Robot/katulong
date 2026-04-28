//! HTTP wire types for the auth ceremony surface.
//!
//! Three flows × two phases each:
//! - **register** (first-device, localhost-only bootstrap):
//!   `register/start` → `register/finish`
//! - **login** (any device with an enrolled credential):
//!   `login/start` → `login/finish`
//! - **pair** (additional device via setup token):
//!   `pair/start` → `pair/finish`
//!
//! Register-start and login-start take no request body, so
//! there's no `RegisterStartRequest` / `LoginStartRequest`
//! type — those routes parse the `()` body. Pair-start needs
//! the plaintext setup token, so it has a request struct.
//!
//! All three start endpoints return a challenge wrapped in a
//! generic envelope (`ChallengeStartResponse<T>`). The `T`
//! varies because register/pair return registration options
//! (`CreationChallengeResponse`) while login returns
//! authentication options (`RequestChallengeResponse`).
//! Concrete aliases are provided for the WASM client where
//! generic deserialisation is awkward.
//!
//! Pair-start additionally echoes a `setup_token_id` back to
//! the client so `pair/finish` can reference the redeemable
//! token without re-submitting the plaintext value. That's
//! defence in depth (the plaintext transits the network
//! once), and it's why pair has its own response type rather
//! than reusing the generic envelope.
//!
//! All three finish endpoints converge on the same response
//! shape (`AuthFinishResponse`) — the server has minted a
//! session cookie via `Set-Cookie` and returns the
//! credential id (for UI display) and the CSRF token (for
//! the client to echo on subsequent state-changing requests).
//!
//! `ChallengeId` is exposed as a type alias rather than a
//! newtype because the server side already has its own
//! `katulong_auth::webauthn::ChallengeId = String` alias and
//! the wire format is just a string. A newtype here would
//! force every consumer to convert at the boundary for no
//! safety gain.

use serde::{Deserialize, Serialize};

// Re-export the WebAuthn proto types so consumers can pull
// every wire-related type through `katulong_shared::wire`,
// not split between `katulong_shared::wire` (envelopes) and
// `katulong_auth::webauthn_wire` (credentials). Single import
// path keeps the boundary unambiguous.
pub use webauthn_rs_proto::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse,
};

pub type ChallengeId = String;

// --- start: shared challenge envelope ---------------------------------

/// Generic envelope for the start phase of every ceremony.
#[derive(Debug, Serialize, Deserialize)]
pub struct ChallengeStartResponse<T> {
    pub challenge_id: ChallengeId,
    pub options: T,
}

/// The aliases below exist so the WASM client can write
/// `let start: LoginStartResponse = resp.json().await?` and
/// have the deserialize call resolve without an explicit
/// turbofish.
pub type RegisterStartResponse = ChallengeStartResponse<CreationChallengeResponse>;
pub type LoginStartResponse = ChallengeStartResponse<RequestChallengeResponse>;

// --- finish: shared session response ---------------------------------

/// Returned by every successful finish endpoint
/// (register/finish, login/finish, pair/finish). The status
/// codes still differ per route (201 on register/pair, 200 on
/// login) — that's a transport detail handled at the call
/// site, not part of this type.
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthFinishResponse {
    /// Server-side credential id for the just-authed
    /// credential. Useful for UIs that show "you're signed
    /// in as <device-name>" or for revoke flows.
    pub credential_id: String,
    /// CSRF token the client must echo in the
    /// `X-Csrf-Token` header on subsequent state-changing
    /// requests (logout, revoke, etc.).
    pub csrf_token: String,
}

// --- register flow ---------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterFinishRequest {
    pub challenge_id: ChallengeId,
    pub response: RegisterPublicKeyCredential,
}

// --- login flow ------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginFinishRequest {
    pub challenge_id: ChallengeId,
    pub response: PublicKeyCredential,
}

// --- pair flow (setup-token-gated registration) ----------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct PairStartRequest {
    /// Plaintext setup token value. The server hashes and
    /// looks it up; only redeemable (live, unconsumed)
    /// tokens pass.
    pub setup_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PairStartResponse {
    pub challenge_id: ChallengeId,
    /// Server-side opaque id for the redeemable token.
    /// Echoed back on `pair/finish` so the client doesn't
    /// re-submit the plaintext token a second time.
    pub setup_token_id: String,
    pub options: CreationChallengeResponse,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PairFinishRequest {
    pub challenge_id: ChallengeId,
    pub setup_token_id: String,
    pub response: RegisterPublicKeyCredential,
}
