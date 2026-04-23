//! Transport-agnostic session I/O.
//!
//! See `handle.rs` and project memory `project_transport_agnostic`
//! for the rationale. Short version: every consumer of session
//! messages takes a `TransportHandle`; WS and (future) WebRTC are
//! interchangeable implementations.
//!
//! Slice 9c shipped the abstraction + WS impl + typed protocol.
//! Slice 9d moved all session wire formats to CBOR. Slice 9e added
//! the terminal-message variants (`HelloAck`, `Attach`, `Input`,
//! `Resize`, `Attached`, `Output`, `Error`) that the handshake
//! state machine in `session::handler` drives. WebRTC impl is
//! whichever slice actually ships a client that wants it.

pub mod handle;
pub mod message;
pub mod websocket;

pub use handle::{TransportError, TransportHandle, TransportKind, TransportSendError};
pub use message::{ClientMessage, ServerMessage, PROTOCOL_VERSION};
