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

// --- status probe ----------------------------------------------------

/// Wire-format access classification. The server has its own
/// `crate::access::AccessMethod` (security-critical, owns the
/// loopback-vs-tunnel detection logic); this is the
/// JSON-serialisable mirror used at the response boundary so
/// the WASM client can pattern-match on the same two
/// variants. Snake/lower-case at the wire so a server enum
/// rename doesn't change the JSON shape — the
/// `#[serde(rename_all = "lowercase")]` is the contract.
///
/// Binary by design (`project_access_model_no_lan`): there
/// is no third "LAN" variant.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccessMethod {
    Localhost,
    Remote,
}

/// Response shape for `GET /api/auth/status`. Public route
/// (no auth required) — the WASM client probes this on every
/// page load to discover the current session state and decide
/// whether to render the login form, the post-auth view, or a
/// loading state while the probe is in flight.
///
/// `has_credentials = false` is the signal for "fresh install
/// — go to register flow"; `authenticated = true` is the
/// signal for "session cookie is valid, go to post-auth
/// view"; the remaining case is "show the login form."
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStatusResponse {
    pub access_method: AccessMethod,
    pub has_credentials: bool,
    pub authenticated: bool,
}

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

// =====================================================================
// Tile protocol — see docs/rewrite-tile-protocol.md.
//
// A tile is a `TileDescriptor { id, kind }` record where `kind` carries
// the typed props for that tile type. The host (`<TileHost/>` in
// crates/web) renders by matching on `kind`, so adding a new tile type
// = adding an enum variant + extending the host's match. The compiler
// enforces exhaustiveness at every match site.
//
// Wire-typed (Serialize/Deserialize) so a future persistence slice can
// round-trip the layout to localStorage or server-side without re-
// shaping the protocol.
// =====================================================================

use std::collections::HashMap;

/// Stable identifier for a tile instance. UUID-ish at runtime (the
/// WASM client generates one when adding a tile, server-side
/// persistence stores it verbatim), but the `bootstrap_default`
/// layout uses well-known stable strings (`"default-terminal"`,
/// `"default-status"`) because they're created at App-mount time
/// before any persistence is wired and there's no need for
/// uniqueness across instances of "the bootstrap". Future
/// dynamically-added tiles will use UUIDs.
///
/// Newtype around `String` so a `TileId` can't accidentally be
/// passed where a `ChallengeId` (also `String`) is expected.
#[derive(
    Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct TileId(pub String);

/// What kind of tile, plus the typed props for that kind.
///
/// Two variants today (`Status`, `Terminal`); future variants
/// (`Cluster`, `FileBrowser`, `ClaudeFeed`, etc.) extend this enum
/// and force `<TileHost/>`'s exhaustive match to grow with them.
/// Each variant carries the typed props for that tile type so a
/// field rename can't drift between consumers.
///
/// **Wire-shape contract**: `#[serde(tag = "kind", rename_all =
/// "snake_case")]` produces `{"kind": "terminal", ...}`. Pinned by
/// `tile_kind_*_serializes_*` round-trip tests in
/// `crates/shared/tests/wire_round_trip.rs`.
///
/// **Do NOT add `#[serde(skip_serializing_if = "Option::is_none")]`**
/// to `Option`-typed variant fields. The pinning tests assert that
/// `None` serializes as `"session_id": null` (present-but-null);
/// adding `skip_serializing_if` would silently change the wire shape
/// to omit the field, and consumers that distinguish absent from null
/// would break. If a future schema needs the absent form, do it
/// explicitly with a separate variant, not by tweaking the attribute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TileKind {
    /// Connection-status indicator. No props — the tile reads the
    /// `ConnectionStatus` context directly.
    Status,
    /// Terminal viewport for a tmux session. `session_id = None` is
    /// the unattached state (placeholder today; future slices
    /// populate it when a session is attached).
    Terminal { session_id: Option<String> },
}

/// **Serde fragility note**: `#[serde(flatten)]` over an
/// internally-tagged enum (`TileKind` is `#[serde(tag = "kind")]`)
/// is a serde combination that round-trips correctly via
/// `serde_json` today but is documented as version-sensitive across
/// the serde ecosystem. The `tile_descriptor_flattens_kind_at_root`
/// and `tile_layout_round_trips_with_descriptors` tests are the
/// regression guards — if either fails after a serde / serde_json
/// version bump, that's the signal to revisit this shape (e.g.,
/// promote `kind` out of flatten-position into its own envelope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TileDescriptor {
    pub id: TileId,
    #[serde(flatten)]
    pub kind: TileKind,
}

/// The single state atom for the layout. `<TileHost/>` reads it; the
/// dispatch helpers in `crate::tile::layout` write it.
///
/// Invariants (upheld by the dispatch helpers, not by the type
/// system):
/// - `order` is a permutation of `tiles.keys()`.
/// - `focused_id` is `None` iff `tiles` is empty; otherwise points at
///   a key in `tiles`.
///
/// Future helpers must maintain both. The dangerous one is
/// `remove_tile`: removing the last tile must clear `focused_id`;
/// removing the focused tile must advance focus to the next-or-prev
/// in `order`. The cluster slice (when it lands) must also resolve
/// whether sub-tiles live in `tiles` (forcing the permutation
/// invariant to weaken) or in a separate field — see the design doc
/// for the deferred decision.
///
/// `tiles` is a `HashMap` rather than `Vec<(TileId, _)>` because the
/// dispatch helpers do keyed lookups (focus → descriptor, remove by
/// id, add-or-update). At katulong's tile counts (typically 2–8) a
/// linear scan would be fine; the HashMap is here to keep the API
/// surface honest about the access pattern, not to win on
/// asymptotics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TileLayout {
    pub tiles: HashMap<TileId, TileDescriptor>,
    pub order: Vec<TileId>,
    pub focused_id: Option<TileId>,
}

impl TileLayout {
    /// Empty layout — no tiles, nothing focused. Used when a fresh
    /// signed-in session has no persisted layout to restore.
    pub fn empty() -> Self {
        Self {
            tiles: HashMap::new(),
            order: Vec::new(),
            focused_id: None,
        }
    }

    /// Bootstrap layout for a fresh signed-in session — one
    /// terminal-stub tile (focused) and one status tile. The seed is
    /// shared between the WASM crate (which calls it on the
    /// `AuthPhase::SignedIn` transition when no persisted layout
    /// exists) and any future server-side persistence layer that
    /// might want to mint the same default for new users. Lives here
    /// (rather than in the web crate) so the persistence slice
    /// doesn't have to choose between duplicating the logic and
    /// reaching into the WASM crate.
    ///
    /// **Layout debt**: the Status tile is unreachable in this slice
    /// (no tab bar; the host renders only the focused tile). The
    /// tab-bar slice exposes it; the persistence slice that lands
    /// before the tab bar should treat the orphaned Status tile as
    /// expected layout content, not as garbage to migrate out.
    pub fn bootstrap_default() -> Self {
        let term_id = TileId("default-terminal".to_string());
        let status_id = TileId("default-status".to_string());

        let mut tiles = HashMap::new();
        tiles.insert(
            term_id.clone(),
            TileDescriptor {
                id: term_id.clone(),
                kind: TileKind::Terminal { session_id: None },
            },
        );
        tiles.insert(
            status_id.clone(),
            TileDescriptor {
                id: status_id.clone(),
                kind: TileKind::Status,
            },
        );

        Self {
            tiles,
            order: vec![term_id.clone(), status_id],
            focused_id: Some(term_id),
        }
    }
}
