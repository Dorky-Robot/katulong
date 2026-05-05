//! HTTP wire types for the auth ceremony surface.
//!
//! Two flows × two phases each:
//! - **register** (first-device bootstrap OR additional-device
//!   pairing — same routes, branched server-side on the
//!   optional `setupToken` body field):
//!   `register/options` → `register/verify`
//! - **login** (any device with an enrolled credential):
//!   `login/options` → `login/verify`
//!
//! Phase 0a step 4 collapsed the dedicated `/auth/pair/*`
//! routes into `/auth/register/*` so the Node frontend's
//! single-route-with-optional-token model drives the Rust
//! server unchanged. The pair-specific `PairStartRequest`
//! and `PairFinishRequest` types are gone; a `setupToken`
//! present in the request body switches the handler from
//! the localhost-only-fresh-install branch to the
//! token-gated additional-device branch.
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

/// Body for `POST /auth/register/options`.
///
/// One route serves two purposes (matching Node's
/// `lib/routes/auth-routes.js:70-113`):
/// - **First-device bootstrap**: `setupToken` absent. Server
///   gates on localhost + "no credentials yet" inside its
///   transact closure.
/// - **Additional-device pairing**: `setupToken` present.
///   Server validates the token (must be live, unconsumed,
///   unexpired) and proceeds without the localhost gate.
///
/// `#[serde(default)]` so a request body of `{}` (Node sends
/// `{setupToken: ""}` when the input is empty; the server
/// treats empty-string the same as absent) deserialises with
/// `setup_token = None`. The Content-Type header is still
/// required by `JsonBody` — callers must POST a JSON body
/// even on the no-token branch.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOptionsRequest {
    /// Plaintext setup token. Absent (or empty after Node's
    /// `||''` tolerance) selects the first-device branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_token: Option<String>,
}

/// Body for `POST /auth/register/verify`. Carries the
/// credential payload only — the challenge is recovered from
/// `credential.response.clientDataJSON.challenge` server-side
/// (same pattern as `@simplewebauthn` and `extractChallenge`
/// in `lib/auth-handlers.js`).
///
/// `setup_token` selects the same branch as on the matching
/// `*/options` call: `None` → first-device finish (localhost
/// gated), `Some` → token-gated pair finish. The same plaintext
/// is re-submitted (not an opaque id) so the server can
/// re-resolve it under the state mutex and close the
/// revoke-between-start-and-finish TOCTOU window.
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
// **Wire format: JSON over text frames.** Phase 0b of the cutover
// (this rewrite) drops the CBOR/binary wire that the WASM frontend
// briefly used; the server now speaks the same JSON-over-text
// protocol the Node frontend has spoken since day one. Reasons:
// the cutover plan moves the live frontend from Rust+WASM back to
// the existing Node SPA bundle, and that SPA's WS code (in
// `public/lib/ws-message-handlers.js`) sends `JSON.parse`/
// `JSON.stringify` over text frames. Asking the SPA to learn CBOR
// would spread cutover risk across both server and client; cheaper
// to make the Rust server speak JSON for now and revisit a binary
// wire later if performance demands it.
//
// **`data` fields are UTF-8 strings, not bytes.** Node's tmux
// control-mode parser decodes the octal-escape encoding into UTF-8
// strings BEFORE buffering, so by the time anything reaches the WS
// layer, `output.data` is already a JS string. The Rust server
// matches this: `String::from_utf8_lossy` at the PTY-output boundary
// turns the decoded bytes into a `String` whose ANSI escapes
// (`\x1b[...`) survive verbatim through `serde_json::to_string`.
// Input keystrokes from the client arrive as a `String` with at most
// 8192 chars (matching Node's `validateMessage` cap in
// `lib/websocket-validation.js`).
//
// **Strictness flags.**
// - `#[serde(tag = "type")]` — every message carries a `type`
//   discriminator. Missing discriminator fails parsing.
// - Inbound message names match Node's strings exactly (some are
//   snake_case like `set-tab-icon` — note the literal hyphen — so
//   we use explicit `#[serde(rename = "...")]` annotations rather
//   than a global `rename_all`).
// - `#[serde(deny_unknown_fields)]` is deliberately NOT on the
//   client enum: the Node validator silently ignores extra fields
//   on a recognized `type`, and the SPA does send some (`session`
//   on `input` is sometimes absent, sometimes present). Strictness
//   on a JSON wire we don't fully control would just kick the user.
//   The defense in depth lives in the per-handler validators
//   downstream, not at the parser.
//
// **No handshake.** Phase 0b removed the Hello/HelloAck handshake
// the Rust transport used to require. The Node SPA connects and
// immediately sends `attach`/`subscribe`; the server now starts in
// the `AwaitingAttach` phase the moment the WS opens. Protocol
// version negotiation lives in the auth/cookie surface (the SPA
// asset bundle is served by the same Rust server, so frontend and
// server ship together).
//
// **Why these types live in `shared`.** Server (sends + receives) and
// WASM client (sends + receives) both consume them. Originally lived
// in `crates/server/src/transport/message.rs`; moved here so the
// types are the single source of truth and a server schema change
// can't drift from a hand-rolled WASM mirror. The WASM consumer in
// `crates/web/src/ws.rs` is FROZEN during the cutover — phase 0b
// adapts the server side only; the WASM frontend will be updated in
// a later slice (it doesn't drive the live UI today).
// =====================================================================

/// Messages sent by the client to the server.
///
/// Deserialized from each inbound text WS frame. Binary frames are
/// rejected by the transport layer.
///
/// **Wire-shape contract.** The variant order, `serde(rename = "...")`
/// strings, and field names are part of the public protocol the
/// Node SPA depends on. Any rename or restructure here is a
/// cross-repo wire break — drive it through both
/// `lib/ws-manager.js` (Node, dispatch) and
/// `public/lib/ws-message-handlers.js` (Node, frontend handlers)
/// in lockstep.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ClientMessage {
    /// Application-level heartbeat. Distinct from the WS-protocol
    /// Ping/Pong frames so a non-WS transport (WebRTC DC) can use
    /// the same shape. Server replies with `Pong`.
    #[serde(rename = "ping")]
    Ping,

    /// Bind this transport to a tmux session. The Node SPA sends
    /// this immediately after WS open. `cols`/`rows` are the
    /// client's current dimensions; the server clamps defensively
    /// per `session::dims`.
    ///
    /// `from_seq` (camelCase `fromSeq` on the wire) is the optional
    /// reconnect cursor: `Some(N)` means "I last received bytes
    /// through seq N; please replay `(N..last_seq]` if still in
    /// ring." Absent on first attach.
    ///
    /// **Wire field name caveat.** Node's
    /// `public/lib/ws-message-handlers.js` keeps the cursor in
    /// `pullManager` and re-issues it on `pull { fromSeq }` rather
    /// than on `attach`. We accept both spellings on attach so
    /// either client (Node SPA via pull, WASM client via direct
    /// resume) can drive the protocol; the `from_seq` field stays
    /// optional and defaults to `None`.
    #[serde(rename = "attach")]
    Attach {
        session: String,
        cols: u16,
        rows: u16,
        #[serde(default, rename = "fromSeq", alias = "from_seq")]
        from_seq: Option<u64>,
    },

    /// Keystroke / paste input destined for the PTY. Node's
    /// `validateMessage` caps `data.length` at 8192 chars; the
    /// Rust server enforces the same cap at handler time, not
    /// here at the parser (a hard cap in serde would close the
    /// transport on the first oversize frame; the handler can
    /// error-reply and stay open).
    ///
    /// `session` is optional — Node treats absence as "the
    /// client's currently-active session." The Rust server in
    /// phase 0b accepts only the bound-session form (multi-
    /// session is phase 1) and ignores the field when present
    /// but matching the bound session.
    #[serde(rename = "input")]
    Input {
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },

    /// Window-resize notification. Forwarded to the session
    /// manager via `refresh-client -C cols x rows` through the
    /// per-tile CM. See `session::dims` for the SIGWINCH-storm
    /// history.
    #[serde(rename = "resize")]
    Resize {
        cols: u16,
        rows: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },

    /// Pull missed bytes since `from_seq` (camelCase `fromSeq`).
    /// In phase 0b the server streams `output` eagerly so the
    /// SPA's pull-on-`data-available` flow is a backpressure
    /// helper rather than the primary data path; the server
    /// answers each `pull` with `pull-response` from the ring.
    /// If `from_seq` is older than the ring's tail, the answer
    /// is `pull-snapshot` instead.
    #[serde(rename = "pull")]
    Pull {
        #[serde(rename = "fromSeq")]
        from_seq: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<String>,
    },

    /// Subscribe to a session WITHOUT making it the active one.
    /// Phase 0b deferred — handler returns an `error`. Multi-
    /// session lands in phase 1 (issue #101).
    #[serde(rename = "subscribe")]
    Subscribe { session: String },

    /// Inverse of `subscribe`. Phase 0b deferred.
    #[serde(rename = "unsubscribe")]
    Unsubscribe { session: String },

    /// Switch the active session of an already-attached
    /// connection. Phase 0b deferred — handler returns an
    /// `error`.
    #[serde(rename = "switch")]
    Switch {
        session: String,
        cols: u16,
        rows: u16,
    },

    /// Drift recovery: client detected its terminal contents
    /// disagree with a `state-check` fingerprint and asks for a
    /// fresh snapshot. Phase 0b deferred — handler returns an
    /// `error`.
    #[serde(rename = "resync")]
    Resync { session: String },

    /// Set the icon shown on a session's tab. Note the literal
    /// HYPHEN in the wire string — Node's
    /// `lib/websocket-validation.js` keys this exact form.
    /// Phase 0b deferred.
    #[serde(rename = "set-tab-icon")]
    SetTabIcon {
        session: String,
        icon: Option<String>,
    },

    /// WebRTC SDP offer. Phase 0b stub: the parser accepts the
    /// shape, the handler returns an `error` saying signaling is
    /// not yet implemented. Required so unknown-message-type
    /// validation works against the real Node SPA, which sends
    /// these speculatively.
    #[serde(rename = "rtc-offer")]
    RtcOffer { sdp: String },

    /// WebRTC ICE candidate. Phase 0b stub, see `RtcOffer`.
    #[serde(rename = "rtc-ice-candidate")]
    RtcIceCandidate {
        #[serde(default)]
        candidate: serde_json::Value,
    },
}

/// Messages sent by the server to the client.
///
/// Serialized as JSON onto each outbound text WS frame. The Node
/// SPA dispatches by reading `msg.type` (see
/// `public/lib/ws-message-handlers.js`); any new variant is
/// invisible to it without a corresponding frontend handler.
///
/// **Asymmetry with `ClientMessage`.** Outbound messages are
/// produced by our own code, so we don't need the
/// inbound-side strictness. The variant set here is the
/// minimum-viable cutover surface — the rich Node-side
/// broadcasts (`session-removed`, `session-renamed`,
/// `child-count-update`, etc.) are deferred to phase 1 along
/// with multi-session support; the SPA's session reconciler
/// catches their absence on the next `/sessions` poll.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum ServerMessage {
    /// Application-level heartbeat reply.
    #[serde(rename = "pong")]
    Pong,

    /// Confirms the transport is bound to `session` and carries
    /// the snapshot UTF-8 the SPA writes to xterm.js verbatim.
    /// `data` is the shared headless's serialized contents at
    /// attach time — already includes ANSI escapes for cursor,
    /// color, scroll region.
    ///
    /// **Wire-shape note.** The Rust server today doesn't
    /// maintain a Node-style headless serializer; on a fresh
    /// attach `data` is empty and the SPA's xterm.js renders an
    /// empty buffer that the per-tile shell repopulates via the
    /// post-attach Ctrl-L nudge (see `handler::serve_session`
    /// for that flow). Reconnect with `from_seq` is the same
    /// shape as Node's `pull-response`: the missed bytes come
    /// down as `pull-response`, not as part of `attached`.
    #[serde(rename = "attached")]
    Attached { session: String, data: String },

    /// Pull-cursor seed. Sent immediately after `attached` so
    /// the SPA's `pullManager` knows where its byte counter
    /// starts. Without this, the first `pull` request would
    /// either re-fetch from byte 0 or skip live output.
    #[serde(rename = "seq-init")]
    SeqInit { session: String, seq: u64 },

    /// Live PTY output. `from_seq` (`fromSeq` on the wire) is
    /// the byte offset of the FIRST byte in `data`; `cursor` is
    /// the offset of the byte AFTER the last (== `from_seq +
    /// data.len()`). The SPA advances its pull cursor to
    /// `cursor` on receipt.
    ///
    /// Field naming matches Node's
    /// `lib/ws-manager.js:127-129`: `fromSeq` (camelCase) for
    /// the first-byte offset, `cursor` for the next-byte offset.
    /// Don't unify them under a single name; the Node SPA
    /// reads both keys.
    #[serde(rename = "output")]
    Output {
        session: String,
        data: String,
        #[serde(rename = "fromSeq")]
        from_seq: u64,
        cursor: u64,
    },

    /// Backpressure / catch-up nudge. Server emits when there's
    /// new output that the client should pull. The SPA responds
    /// with `pull { fromSeq: pullManager.cursor }`. Phase 0b
    /// emits this at most once after `seq-init` (the SPA needs
    /// it to kick its initial pull); subsequent live output
    /// flows as direct `output` messages without the
    /// notification.
    #[serde(rename = "data-available")]
    DataAvailable { session: String },

    /// Reply to a client `pull`. `data` is the missed bytes;
    /// `cursor` is the new cursor position. If `data` is the
    /// empty string the cursor still advances (Node uses this
    /// for the backpressure-bypass case).
    #[serde(rename = "pull-response")]
    PullResponse {
        session: String,
        data: String,
        cursor: u64,
    },

    /// Reply to a client `pull` whose cursor was older than the
    /// ring's tail, OR reply to a client `resync`. `data` is a
    /// full pane snapshot the SPA replaces its terminal contents
    /// with; `cursor` seeds the pull manager.
    #[serde(rename = "pull-snapshot")]
    PullSnapshot {
        session: String,
        data: String,
        cursor: u64,
    },

    /// PTY exited. `code` is the wait-status (-1 if unknown).
    /// The SPA shows an "exited" banner.
    #[serde(rename = "exit")]
    Exit { session: String, code: i32 },

    /// Drift detection fingerprint. Phase 0b doesn't emit these
    /// (no shared headless yet); the variant exists for the SPA
    /// dispatcher's exhaustive match. Phase 1 wires it up.
    #[serde(rename = "state-check")]
    StateCheck {
        session: String,
        fingerprint: String,
        seq: u64,
    },

    /// Server tells siblings to resize. Phase 0b doesn't emit
    /// these (no multi-device support yet); variant exists for
    /// dispatcher completeness.
    #[serde(rename = "resize-sync")]
    ResizeSync { cols: u16, rows: u16 },

    /// Generic error envelope the SPA renders into its
    /// connection-status UI. The Node server uses this for both
    /// validation failures (`"Invalid message format"`) and
    /// per-handler errors; Rust matches the loose contract.
    /// `code` is omitted from the wire when not present so we
    /// match Node's exact `{ type, message }` shape.
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}
