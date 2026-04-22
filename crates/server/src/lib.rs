//! katulong HTTP surface.
//!
//! Library crate so integration tests can exercise the router without
//! spinning up a TCP listener. `main.rs` binds the socket; `app()` here
//! returns the router ready for `axum::serve` or an in-process tower
//! client.

pub mod access;
pub mod auth_middleware;
pub mod cookie;
pub mod state;

use auth_middleware::Authenticated;
use axum::{routing::get, Json, Router};
use katulong_shared::{ServerMessage, PROTOCOL_VERSION};
use serde_json::json;
use state::AppState;

/// Build the router with the given application state.
///
/// Separated from `main.rs` so tests can spin up the router against
/// ephemeral `AuthStore`/`WebAuthnService` instances without opening a
/// socket. The `/api/me` route is the slice-4 smoke signal — it returns
/// 200 with the credential id on authenticated requests, 401 otherwise.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/hello", get(hello))
        .route("/api/me", get(me))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn hello() -> Json<ServerMessage> {
    Json(ServerMessage::Hello {
        protocol_version: PROTOCOL_VERSION.to_string(),
    })
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
