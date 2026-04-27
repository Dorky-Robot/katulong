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
use axum::{extract::DefaultBodyLimit, routing::get, Json, Router};
use serde_json::json;
use state::AppState;
use std::path::PathBuf;
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
/// "ok"), and the static-asset fallback at `/` (the Leptos
/// frontend bundle — `katulong-web`'s `dist/`).
pub fn app(state: AppState) -> Router {
    Router::new()
        // PUBLIC: liveness probe. Returns static "ok".
        .route("/health", get(health))
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
        .fallback_service(ServeDir::new(web_dist_path()))
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .with_state(state)
}

/// Resolve the trunk-output directory for the Leptos frontend.
/// Operator-overridable via `KATULONG_WEB_DIST`; default is
/// `crates/web/dist` relative to the binary's working
/// directory. The staging script always sets the env var so
/// production paths don't depend on cwd.
fn web_dist_path() -> PathBuf {
    std::env::var_os("KATULONG_WEB_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("crates/web/dist"))
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
