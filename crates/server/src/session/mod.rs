//! Terminal session layer.
//!
//! Wraps tmux via its `-C` control-mode protocol. This slice (9b)
//! ships the scaffold — protocol parser, tmux subprocess client,
//! and a SessionManager with create/list/destroy/resize. Slice 9c
//! wires it into `AppState` and the WS terminal handler.

pub mod dims;
pub mod manager;
pub mod parser;
pub mod tmux;

pub use manager::{SessionError, SessionManager};
pub use tmux::{CommandReply, Tmux, TmuxError, DEDICATED_SOCKET_NAME};
