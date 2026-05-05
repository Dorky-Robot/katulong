//! katulong HTTP surface.
//!
//! Library crate so integration tests can exercise the router without
//! spinning up a TCP listener. `main.rs` binds the socket; `app()` here
//! returns the router ready for `axum::serve` or an in-process tower
//! client.

pub mod access;
pub mod api;
pub mod auth_middleware;
pub mod cookie;
pub mod log_util;
pub mod revocation;
pub mod session;
pub mod state;
pub mod transport;
pub mod ws;

use api::auth::auth_routes;
use api::devices::device_routes;
use api::tokens::token_routes;
use auth_middleware::Authenticated;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use cookie::extract_session_token;
use serde_json::json;
use state::AppState;
use std::time::SystemTime;
use tower_http::services::ServeDir;

/// Hard ceiling on request body bytes. 1 MiB matches the Node
/// implementation's per-auth-route limit. Applied globally here rather
/// than per-route so future POST routes (slice 5) can't forget to set
/// their own cap — the axum `content-length` check rejects over-large
/// requests before they reach any handler.
const REQUEST_BODY_LIMIT: usize = 1024 * 1024;

/// Build the router with the given application state.
///
/// Separated from `main.rs` so tests can spin up the router against
/// ephemeral `AuthStore`/`WebAuthnService` instances without opening a
/// socket.
///
/// # Public-route convention
///
/// By default **every route is unauthenticated** — axum only runs the
/// `Authenticated` extractor when a handler asks for it. When adding a
/// route, the reviewer asks: does this handler take `Authenticated`?
/// If no, add an explanatory comment next to the `.route(...)` line
/// explaining WHY it's public (health probe, protocol handshake,
/// auth-kickoff endpoint, etc.) so the allowlist is reviewable
/// inline. The Node implementation kept this allowlist centralised as
/// `isPublicPath()`; we enforce it socially instead, which means the
/// comments ARE the contract.
///
/// Currently public: `/health` (k8s/uptime probe, returns static
/// "ok"), `/` (SPA shell with conditional CSRF meta-tag
/// injection — see `index_html`), and the static-asset fallback
/// (the Leptos frontend bundle — `katulong-web`'s `dist/`, served
/// for every path not explicitly routed above).
pub fn app(state: AppState) -> Router {
    let dist = state.config.web_dist.clone();
    Router::new()
        // PUBLIC: liveness probe. Returns static "ok".
        .route("/health", get(health))
        // PUBLIC: SPA shell. Reads `crates/web/dist/index.html`
        // and — if the request carries a valid session cookie —
        // injects `<meta name="csrf-token" content="...">` into
        // the `<head>`. The frontend reads this meta on boot and
        // mirrors the token into `X-Csrf-Token` on every
        // state-changing fetch.
        //
        // The injection is conditional on a valid session cookie
        // because the login page (no cookie yet) doesn't make
        // CSRF-protected calls — the auth ceremonies are
        // CSRF-exempt by their own challenge-response design.
        // Adding a meta tag with no token would be wrong; adding
        // one with a fake token would be worse.
        //
        // ServeDir keeps catching every OTHER path
        // (`/index.html`, the hashed JS/WASM bundle filenames
        // trunk emits, `/style.css`, etc.) — only the literal
        // root route gets the meta-tag treatment, mirroring the
        // Node port (`lib/routes/app-routes.js:251-260`).
        .route("/", get(index_html))
        // PROTECTED: smoke-test endpoint that exercises the full
        // auth extractor chain (access classification, cookie
        // extraction, store lookup) in a single round-trip.
        // Integration tests target this route.
        .route("/api/me", get(me))
        // Auth ceremony routes. Each endpoint's public/protected
        // status is documented on the route line inside the module.
        .merge(auth_routes())
        // Setup-token management (list/create/revoke). All protected;
        // state-changing ones additionally require CSRF.
        .merge(token_routes())
        // Device (credential) management (list/revoke). Same
        // auth/CSRF shape as tokens.
        .merge(device_routes())
        // PROTECTED: WebSocket upgrade → `TransportHandle`.
        // Auth + Origin validation at upgrade time; the consumer
        // loop runs against the transport abstraction so WebRTC
        // (later slice) can drop in without touching this line.
        .route("/ws", get(ws::ws_handler))
        // PUBLIC: static-asset fallback. `ServeDir` matches any
        // path not handled above, so specific routes (`/health`,
        // `/api/*`, `/ws`) take precedence and the SPA shell
        // catches everything else (`/`, `/index.html`, the
        // hashed JS/WASM bundle filenames trunk emits).
        //
        // The dist directory is the trunk output of
        // `crates/web` — the Leptos frontend. Path resolution:
        // `KATULONG_WEB_DIST` env var if set; otherwise
        // `crates/web/dist` relative to the working directory
        // where the binary was launched. The staging script
        // (bin/katulong-stage) sets the env var explicitly so
        // the binary's cwd doesn't matter.
        //
        // Path traversal: tower-http's `ServeDir` v0.5
        // normalizes the request path and rejects any `..`
        // escape attempts before joining to the configured
        // root. Equivalent to the Node implementation's manual
        // `filePath.startsWith(publicDir)` prefix check.
        //
        // Body limit coverage: axum 0.7's `Router::fallback_
        // service` applies subsequent `.layer()` calls to BOTH
        // the routed surface AND the fallback (changed from
        // 0.6 behavior). So the `DefaultBodyLimit` below
        // covers ServeDir requests too — no need to wrap
        // ServeDir separately.
        .fallback_service(ServeDir::new(dist))
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn me(Authenticated(ctx): Authenticated) -> Json<serde_json::Value> {
    Json(json!({
        "access": match &ctx {
            auth_middleware::AuthContext::Localhost => "localhost",
            auth_middleware::AuthContext::Remote { .. } => "remote",
        },
        "credential_id": ctx.credential_id(),
    }))
}

/// Serve `index.html`, optionally injecting a `<meta name="csrf-token">`
/// when the request carries a valid session cookie.
///
/// The Node port (`lib/routes/app-routes.js:251-260`) does the
/// same string-replace on `<head>` to land the meta tag. We
/// match that approach byte-for-byte rather than reach for an
/// HTML parser — both servers agree the `<head>` literal lives
/// in `index.html` and breaking that contract would already
/// break ServeDir-based static deployments anyway.
///
/// Failure modes:
///
/// - File missing → 500. trunk should always produce
///   `dist/index.html`; absence indicates a deployment bug.
/// - Cookie present but unknown/expired → no injection. Treated
///   the same as no cookie: the frontend will need to log in to
///   pick up a fresh token.
async fn index_html(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let path = state.config.web_dist.join("index.html");
    let html = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(err) => {
            tracing::error!(?path, %err, "index_html: failed to read dist/index.html");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal server error").into_response();
        }
    };

    let html = if let Some(token) = csrf_token_for_request(&state, &headers).await {
        // Inject before the FIRST `</head>` so we don't
        // accidentally hit a literal inside a `<script>` body.
        // Searching for the bare `</head>` literal (without
        // surrounding whitespace) survives trunk's HTML
        // minification, which collapses indentation in release
        // builds. The Node port (`app-routes.js:251-260`) does
        // the equivalent with `.replace("<head>", ...)`; we go
        // before `</head>` because the dist HTML may have
        // injected `<link data-trunk>` derivatives between the
        // open tag and our intended insertion point.
        //
        // The token itself is 64 hex chars from the CSPRNG, so
        // there's nothing to escape — but `escape_attr` runs
        // unconditionally to preserve the contract that any
        // value going into an HTML attribute is escaped at the
        // point of injection. A future schema where the CSRF
        // value gets a wider alphabet wouldn't silently produce
        // a quote-injection.
        let meta = format!(
            "<meta name=\"csrf-token\" content=\"{}\"></head>",
            escape_attr(&token)
        );
        html.replacen("</head>", &meta, 1)
    } else {
        html
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

/// Resolve the CSRF token paired with the request's session
/// cookie, if any. Returns `None` for unauthenticated requests
/// (no cookie, unknown token, expired session) — the meta tag
/// is then omitted entirely so the frontend sees `null` from
/// `document.querySelector('meta[name="csrf-token"]')` rather
/// than a fake value. Localhost peers also get `None`: there's
/// no session and no CSRF pairing there (physical-access trust
/// model), and the `CsrfProtected` extractor's localhost bypass
/// makes the meta tag unnecessary for state-changing calls.
async fn csrf_token_for_request(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(extract_session_token)?;
    let snap = state.auth_store.snapshot().await;
    let session = snap.valid_session(&token, SystemTime::now())?;
    Some(session.csrf_token.clone())
}

/// Minimal HTML attribute escape: the five characters that can
/// break out of a double-quoted attribute value
/// (`& < > " '`). Token format today is hex-only so this is a
/// belt-and-braces guard for forward compatibility — see the
/// inline comment at the call site.
fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}
