//! HTTP wire types for the auth ceremony surface.
//!
//! Three flows × two phases each:
//! - **register** (first-device, localhost-only bootstrap):
//!   `register/options` → `register/verify`
//! - **login** (any device with an enrolled credential):
//!   `login/options` → `login/verify`
//! - **pair** (additional device via setup token):
//!   `pair/options` → `pair/verify`
//!
//! Phase 0a-1 of the cutover reshapes these to match the
//! Node frontend wire shapes byte-for-byte:
//!
//! - Each `*/options` endpoint returns the bare WebAuthn
//!   options object at the JSON top level (no
//!   `challenge_id`, no `options` envelope). Node's handler
//!   does `res.json(opts)` where `opts` is the
//!   `@simplewebauthn` options output; we mirror that by
//!   handing back the raw `CreationChallengeResponse` /
//!   `RequestChallengeResponse`.
//! - Each `*/verify` endpoint takes a body that carries only
//!   the credential payload. The challenge no longer
//!   round-trips through a server-issued id; instead the
//!   server recovers it from the credential's
//!   `clientDataJSON.challenge` at verify time. That's the
//!   `@simplewebauthn` model and what `extractChallenge` in
//!   `lib/auth-handlers.js` does on the Node side.
//!
//! Consequence: `ChallengeId` is gone from the public wire,
//! and so is the `ChallengeStartResponse<T>` envelope. The
//! types that survive are bodies the Node frontend (and the
//! WASM frontend, post-cutover) actually exchange.
//!
//! All three verify endpoints converge on the same response
//! shape (`AuthFinishResponse`) — the server has minted a
//! session cookie via `Set-Cookie` and returns the
//! credential id (for UI display) and the CSRF token (for
//! the client to echo on subsequent state-changing requests).

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

/// Response shape for `GET /auth/status`. Public route (no
/// auth required) — the WASM client probes this on page load
/// to choose between register / login / pair UIs.
///
/// **Wire shape matches Node's `lib/routes/auth-routes.js`:**
/// `{ setup, accessMethod }`. `setup` is `true` once any
/// credential exists on the instance; `accessMethod` is the
/// camelCase mirror of the server's classification (the JSON
/// frontend reads `accessMethod`, not `access_method`).
///
/// Phase 0a-1 of the cutover dropped the `authenticated`
/// field — Node never returned it and the JS frontend never
/// read it. Whether the caller has a live session is
/// recoverable from a separate `/api/me` probe (sibling PR).
#[derive(Debug, Serialize, Deserialize)]
pub struct AuthStatusResponse {
    /// `true` once any credential exists on the instance.
    /// Mirrors Node's `isSetup()` boolean — drives the
    /// frontend's "fresh install → register" vs.
    /// "credentials exist → sign in" branch.
    pub setup: bool,
    /// Camel-cased on the wire (`accessMethod`) to match
    /// Node's `getAccessMethod()` output. The Rust enum stays
    /// snake-case internally; the rename is at the wire
    /// boundary only.
    #[serde(rename = "accessMethod")]
    pub access_method: AccessMethod,
}

// --- finish: shared session response ---------------------------------

/// Returned by every successful verify endpoint
/// (register/verify, login/verify, pair/verify). The status
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

/// Body for `POST /auth/register/verify`. Carries the
/// credential payload only — the challenge is recovered from
/// `credential.response.clientDataJSON.challenge` server-side
/// (same pattern as `@simplewebauthn` and `extractChallenge`
/// in `lib/auth-handlers.js`).
///
/// `setup_token` is reserved for the follow-up PR that merges
/// the register and pair flows into a single endpoint; today
/// it stays `None` on first-device registration. Landing the
/// field now means the type doesn't need a second wire
/// migration when that merge happens.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterFinishRequest {
    pub credential: RegisterPublicKeyCredential,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_token: Option<String>,
    /// Optional human label for the credential ("Felix iPhone").
    /// Persisted to `Credential.name` for the device-management
    /// UI. Defaults to empty when missing — matches Node's
    /// `deviceName || ''` tolerance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// Optional User-Agent capture from the registering browser.
    /// Surfaced on the device-management UI so an operator can
    /// match a passkey row to the device that minted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

// --- login flow ------------------------------------------------------

/// Body for `POST /auth/login/verify`. The struct exists
/// purely so the WASM frontend can name it; the wire shape is
/// `{ "credential": <PublicKeyCredential> }`.
#[derive(Debug, Serialize, Deserialize)]
pub struct LoginFinishRequest {
    pub credential: PublicKeyCredential,
}

// --- pair flow (setup-token-gated registration) ----------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct PairStartRequest {
    /// Plaintext setup token value. The server hashes and
    /// looks it up; only redeemable (live, unconsumed)
    /// tokens pass.
    pub setup_token: String,
}

/// Body for `POST /auth/pair/verify`.
///
/// Carries the plaintext `setup_token` again rather than an
/// opaque `setup_token_id` echoed from `pair/options`. The
/// server re-validates redemption under the state mutex —
/// that re-validation is the authoritative gate, not whether
/// the client echoed an id correctly. This shape matches the
/// Node implementation.
///
/// The challenge is recovered from
/// `credential.response.clientDataJSON.challenge` server-side.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairFinishRequest {
    pub credential: RegisterPublicKeyCredential,
    pub setup_token: String,
    /// Optional human label for the paired credential. Persisted to
    /// `Credential.name`; defaults to empty when missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// Optional User-Agent capture from the pairing browser.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
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

// =====================================================================
// Session protocol — typed wire for the WebSocket session layer.
//
// Every message crossing the transport boundary is one of these
// variants — no `serde_json::Value` catch-alls, no loosely-typed
// payloads. The Node scar that motivated this (`9dc7c78`) was a
// terminal that accepted unvalidated JSON and passed fields straight
// to PTY resize/input — `"999999"` where a number was expected could
// cause type confusion. Rust's types + serde's strictness close that
// class of bug at parse time; we just have to be disciplined about
// not reintroducing `Value` as an escape hatch.
//
// **Wire format: CBOR.** Messages encode via CBOR (`ciborium`) into
// binary frames. JSON is used only for the HTTP API (cookies, error
// envelopes, token CRUD). Uniform binary over both WS and (future)
// WebRTC DataChannel; no base64 overhead for byte payloads; smaller
// wire; same serde derives.
//
// **Byte-string encoding for `Input`/`Output`.** `Input { data }` and
// `Output { data }` carry raw terminal bytes. Their `data` fields are
// annotated `#[serde(with = "serde_bytes")]` so CBOR emits a major-
// type-2 byte string instead of the serde-default array of small
// integers. Without the annotation, a 1 KiB paste would encode as
// ~1–2 KiB of integer elements; with it the payload rides the wire
// literally.
//
// **Strictness flags.**
// - `#[serde(tag = "type", rename_all = "snake_case")]` — every
//   message carries a `type` discriminator and snake_case field
//   names. Missing discriminator fails parsing.
// - `#[serde(deny_unknown_fields)]` on `ClientMessage` only — inbound
//   strictness is a security property; outbound `ServerMessage` stays
//   lenient so older Rust consumers (tests, federation relays) can
//   deserialize newer-server output without hard-failing on unknown
//   fields.
//
// **Handshake.** Three-step gate before terminal I/O is valid:
//   1. Server → Client: `Hello { protocol_version }` on upgrade.
//   2. Client → Server: `HelloAck { protocol_version }`. Server re-
//      validates; mismatch → `Error { code:
//      "protocol_version_mismatch", ... }` and close.
//   3. Client → Server: `Attach { session, cols, rows }`. Server
//      replies `Attached`.
// Only after `Attached` are `Input`/`Resize` accepted.
// `Ping`/`Pong` is allowed in every phase (liveness is orthogonal).
//
// **Why these types live in `shared`.** Server (sends + receives) and
// WASM client (sends + receives) both consume them. Originally lived
// in `crates/server/src/transport/message.rs`; moved here so the
// types are the single source of truth and a server schema change
// can't drift from a hand-rolled WASM mirror.
// =====================================================================

/// Current protocol version. Clients check this against their
/// expected value and refuse to proceed on mismatch. Bumped when a
/// non-backwards-compatible change lands (new required field, removed
/// variant, changed semantics).
pub const PROTOCOL_VERSION: &str = "katulong/0.1";

/// Messages sent by the client to the server.
///
/// Deserialized from each inbound CBOR binary frame. Text frames are
/// rejected by the transport layer. Byte payloads (terminal input,
/// future image paste) carry directly via CBOR's byte-string type —
/// no base64 wrapper needed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientMessage {
    /// Client heartbeat. Server echoes with `Pong` carrying the same
    /// `nonce` — lets the client measure round-trip latency without
    /// assuming a specific transport's heartbeat primitive (WS Ping
    /// frames vs WebRTC DC keep-alives differ).
    Ping { nonce: u64 },

    /// Acknowledge the server's `Hello` and confirm the client speaks
    /// the same protocol version. Sent exactly once, as the first
    /// message after the client receives `Hello`. The server re-
    /// checks the version and closes on mismatch.
    HelloAck { protocol_version: String },

    /// Bind this transport to a tmux session. `session` is the tmux
    /// session name (validated by `SessionManager`); `cols`/`rows`
    /// are the client's current window dimensions (clamped
    /// defensively server-side per `session::dims`). Sent exactly
    /// once after `HelloAck`. The server creates the session if it
    /// doesn't exist (or attaches to the existing one) and replies
    /// with `Attached`.
    ///
    /// `resume_from_seq`: reconnect hint. Absent (or `None`) means
    /// "fresh attach — I have no prior state." `Some(N)` means "I
    /// last received bytes through seq N; please replay bytes
    /// `(N..last_seq]` if you still have them." If the server's ring
    /// has lost bytes below `N`, it emits `OutputGap` before the
    /// replay so the client clears its terminal first. Omit on first
    /// attach; echo the seq from `Attached.last_seq` on reconnect.
    Attach {
        session: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        resume_from_seq: Option<u64>,
    },

    /// Keystroke / paste input destined for the PTY. Only valid after
    /// `Attached`.
    Input {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },

    /// Window-resize notification. Only valid after `Attached`.
    /// Forwarded to the session manager, which clamps and issues a
    /// tmux `refresh-client -C`. Do NOT send on every keystroke — see
    /// `session::dims` for the SIGWINCH-storm history.
    Resize { cols: u16, rows: u16 },
}

/// Messages sent by the server to the client.
///
/// Serialized as CBOR binary frames. Clients treat any message with
/// an unknown `type` field as a forward-compat signal and log but
/// don't reject — we want server → client additions to be deployable
/// without client pinning.
///
/// **Asymmetry with `ClientMessage`.** `deny_unknown_fields` is
/// deliberately OMITTED here. The strict boundary is INBOUND: the
/// server rejects unknown client input because that's untrusted data.
/// Outbound messages from the server are produced by our own code;
/// relaxing this direction lets older Rust clients deserialize
/// newer-server output without hard-failing on fields they don't
/// understand.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Sent immediately after a successful transport upgrade. Tells
    /// the client the connection is live and which protocol version
    /// the server speaks. The client can refuse to proceed if the
    /// version doesn't match its own expectation.
    Hello { protocol_version: String },

    /// Response to a client `Ping`. Echoes the same nonce.
    Pong { nonce: u64 },

    /// Confirms that this transport is bound to `session`, which has
    /// been resized to the clamped `cols`/`rows`. The client should
    /// use these (not what it requested) as the authoritative
    /// dimensions for its local renderer.
    ///
    /// `last_seq` is the pane's current `total_written` — the byte
    /// counter the ring is at when this `Attached` ships. Fresh-
    /// attach client seeds its local seq from here. Reconnect client
    /// uses it as the upper bound of the replay they're about to
    /// receive. `0` on a fresh pane (no output ever produced).
    Attached {
        session: String,
        cols: u16,
        rows: u16,
        last_seq: u64,
    },

    /// PTY output chunk. `seq` is the pane's `total_written`
    /// (cumulative decoded byte offset) at the end of this chunk — a
    /// per-PANE monotonic counter that continues across subscriber
    /// displace/reconnect boundaries.
    ///
    /// **Seq contract.** `seq` is 1-based at the first-byte level:
    /// the first outbound byte of a pane carries `end_seq = 1`; seq =
    /// 0 is reserved to mean "no output produced yet" (used in
    /// `Attached.last_seq` on a cold pane). Clients counting gaps see
    /// monotonic progress across reconnect as long as the server
    /// process has not restarted; a decrease means a fresh server
    /// instance and the client must treat it as a hard reset.
    Output {
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
        seq: u64,
    },

    /// Protocol-level error. The server sends this right before
    /// closing the transport so the client sees a concrete reason in
    /// logs rather than an opaque WS close frame.
    Error { code: String, message: String },

    /// Reconnect replay had a gap: the client's `resume_from_seq` was
    /// older than the oldest byte still in the pane's ring.
    /// `available_from_seq` is the oldest byte we can replay (>
    /// the client's request); `last_seq` matches `Attached.last_seq`
    /// for convenience. The client MUST clear its terminal / restart
    /// its renderer before applying any subsequent `Output` — cursor
    /// positions and in-flight escape sequences from the lost window
    /// can't be inferred.
    OutputGap {
        available_from_seq: u64,
        last_seq: u64,
    },
}
