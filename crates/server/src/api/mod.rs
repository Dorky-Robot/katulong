//! HTTP API surface.
//!
//! Routes grouped by domain. Each domain module exposes a
//! `*_routes() -> Router<AppState>` function that `lib.rs::app()`
//! merges into the main router. The `error` module owns the HTTP
//! error shape so handlers return `Result<Json<T>, ApiError>` and
//! the status-code + body mapping happens in exactly one place.

pub mod auth;
pub mod error;
