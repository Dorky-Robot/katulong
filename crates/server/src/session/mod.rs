//! Terminal session layer.
//!
//! Wraps tmux via its `-C` control-mode protocol.
//!
//! - `parser` — control-mode notification parser (`%begin`, `%end`,
//!   `%output`, ...).
//! - `tmux` — subprocess client; owns the long-running `tmux -C -L
//!   katulong` process and multiplexes commands over its stdin.
//! - `manager` — `SessionManager` with create/list/destroy/resize,
//!   built on top of `tmux`.
//! - `dims` — multi-device dimension discipline (commentary +
//!   constants; see `CLAUDE.md`).
//! - `handler` — per-connection consumer loop. Runs the handshake
//!   state machine and revocation watch against a
//!   `TransportHandle`.
//!
//! Slice 9f will wire the output forwarding path from
//! `tmux::Tmux`'s notification stream into the per-connection
//! `ServerMessage::Output` producer, with the coalescing + resize
//! gating imported from the Node scars (`d311168`, `066dab2`,
//! `da6907f`).

pub mod dims;
pub mod handler;
pub mod manager;
pub mod output;
pub mod parser;
pub mod ring;
pub mod router;
pub mod tmux;

pub use handler::serve_session;
pub use manager::{SessionError, SessionManager};
pub use router::OutputRouter;
pub use tmux::{CommandReply, Tmux, TmuxError, DEDICATED_SOCKET_NAME};
