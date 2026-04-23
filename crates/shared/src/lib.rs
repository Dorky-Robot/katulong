//! Types shared between `katulong-server` and any future
//! cross-crate consumer (e.g., the eventual Leptos client, the
//! tile SDK).
//!
//! The slice-4 scaffold originally defined placeholder
//! `ServerMessage`/`ClientMessage`/`PROTOCOL_VERSION` here to
//! verify end-to-end wiring. Slice 9c deleted those: the
//! authoritative WS protocol now lives in
//! `katulong_server::transport::message`, and the HTTP smoke
//! endpoint (`/api/hello`) it backed is gone — the real auth
//! handshake is `GET /api/auth/status`. Keeping two parallel
//! `ServerMessage` types (different tag keys, different casing,
//! different version strings) was the CRITICAL finding in the
//! slice-9c review; removing the dead scaffold is the fix.
//!
//! This crate stays in the workspace because truly cross-crate
//! shared types — tile-SDK message envelopes, federation
//! primitives, whatever lands later — will live here. For now
//! it's intentionally empty.
