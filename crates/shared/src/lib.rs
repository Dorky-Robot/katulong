//! Cross-crate types shared between `katulong-server` and
//! `katulong-web`.
//!
//! The slice-4 scaffold once held placeholder
//! `ServerMessage`/`ClientMessage` types that diverged from
//! the live WS protocol; slice 9c removed them. This crate
//! sat empty until the auth-rewrite slices grew enough wire
//! types (login/register/pair × start/finish) that
//! duplicating them on both sides became silent-drift
//! prone. The wire module below is the single source of
//! truth: server uses these structs to build responses and
//! deserialize requests; the WASM client uses the same
//! structs in the reverse direction.
//!
//! What belongs here: types that cross the HTTP/WS boundary
//! and must serialize identically on both sides.
//! What does NOT belong here: server-side state types
//! (auth_store, session manager), WASM-side view types
//! (Leptos signals), anything with an axum/sqlx/web-sys dep.
//! The point of the crate is to be cheap to depend on from
//! either side; keeping its dependency surface to `serde` +
//! `webauthn-rs-proto` is what makes that true.

pub mod wire;
