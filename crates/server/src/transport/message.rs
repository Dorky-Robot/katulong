//! Session protocol types — server-side facade over
//! `katulong_shared::wire`.
//!
//! The actual `ClientMessage` / `ServerMessage` definitions live in
//! the shared crate so the WASM client can import the same types.
//! This module re-exports them so existing server-internal call
//! sites (`use crate::transport::message::*`) keep working without
//! churn.
//!
//! See `katulong_shared::wire` for the full protocol documentation
//! (JSON-over-text-frames wire format, no handshake, message-name
//! contract with the Node SPA). Tests for the protocol shape live
//! in `crates/shared/tests/session_message.rs` so they ride
//! alongside the type definitions.
//!
//! Note: phase 0b of the Node-cutover removed the
//! `PROTOCOL_VERSION` constant. The Node SPA has no
//! Hello/HelloAck handshake; the server now starts in the
//! awaiting-attach phase the moment the WS opens. If a future
//! protocol-versioning slice lands, it should pick a different
//! mechanism (e.g., a header on the WS upgrade) rather than
//! resurrecting the in-band handshake.

pub use katulong_shared::wire::{ClientMessage, ServerMessage};
