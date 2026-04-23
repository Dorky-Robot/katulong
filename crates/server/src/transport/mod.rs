//! Transport-agnostic session I/O.
//!
//! See `handle.rs` and project memory `project_transport_agnostic`
//! for the rationale. Short version: every consumer of session
//! messages takes a `TransportHandle`; WS and (future) WebRTC are
//! interchangeable implementations.
//!
//! This slice (9c) ships the abstraction + WS impl + typed
//! protocol. Terminal wiring is slice 9d; WebRTC impl is whichever
//! slice actually ships a client that wants it.

pub mod handle;
pub mod message;
pub mod websocket;

pub use handle::{TransportError, TransportHandle, TransportKind, TransportSendError};
pub use message::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
