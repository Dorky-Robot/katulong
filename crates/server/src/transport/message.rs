//! Session protocol types — server-side facade over
//! `katulong_shared::wire`.
//!
//! The actual `ClientMessage` / `ServerMessage` / `PROTOCOL_VERSION`
//! definitions live in the shared crate so the WASM client can
//! import the same types. This module re-exports them so existing
//! server-internal call sites (`use crate::transport::message::*`)
//! keep working without churn.
//!
//! See `katulong_shared::wire` for the full protocol documentation
//! (CBOR wire format, `serde_bytes` byte-string contract, handshake,
//! strictness flags). Tests for the protocol shape live in
//! `crates/shared/tests/session_message.rs` so they ride alongside
//! the type definitions.

pub use katulong_shared::wire::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
