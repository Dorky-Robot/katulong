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
//! state machine in `session::handler` drives. Phase 0b of the
//! Node-cutover replaced the CBOR-binary wire with JSON over text
//! frames so the existing Node SPA in `public/lib/...` can drive
//! the Rust server unmodified, and removed the in-band
//! Hello/HelloAck handshake (Node's SPA never spoke that). WebRTC
//! impl is whichever slice actually ships a client that wants it.

pub mod handle;
pub mod message;
pub mod websocket;

pub use handle::{TransportError, TransportHandle, TransportKind, TransportSendError};
pub use message::{ClientMessage, ServerMessage};
