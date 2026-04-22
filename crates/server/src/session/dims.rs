//! Multi-device terminal-dimension discipline.
//!
//! This module is entirely commentary + constants. It has no
//! functions today — it's the codified version of the lessons in
//! `CLAUDE.md` so slice-9c/9d authors can find them at the point
//! where they'd reach for "just resize on every attach" and be
//! reminded why that's wrong.
//!
//! # A tmux pane has exactly one size
//!
//! `TIOCGWINSZ` returns one answer per PTY. The shell and every
//! program in it see that single value. There is no way to have a
//! running process simultaneously render at 40 columns (phone) and
//! 200 columns (desktop). This is not a tmux quirk — it's how PTYs
//! work.
//!
//! Consequence: when a phone attaches and resizes tmux, the
//! desktop sees output formatted for phone width (text wraps
//! early, wastes screen space). This is unfixable at this layer.
//! Future options live OUTSIDE a single-PTY-per-session shape:
//! per-device tmux windows, a primary-device model, or "don't
//! resize on attach — each device keeps what it found."
//!
//! # Do-not-resize paths (ported from Node)
//!
//! 1. **Keystroke-driven active-client switching does NOT trigger
//!    resize.** Node's `markActive()` in `client-tracker.js`
//!    deliberately skipped resize on keystroke events, because
//!    otherwise a user typing on their desktop while a phone is
//!    connected would cause a SIGWINCH storm that garbles TUI
//!    apps (vim, htop, etc.). Only explicit events — attach,
//!    detach, browser window resize — should resize tmux.
//!
//! 2. **Never resize per-client.** ClientHeadless (PCH-7 in Node)
//!    tried to run separate headless xterm.js instances per client
//!    at different dimensions. This actively introduced drift
//!    because TUI apps emit absolute cursor positioning escapes
//!    (`\e[row;colH`) calculated for tmux's current size —
//!    replaying those into a differently-sized headless lands the
//!    escapes on wrong cells. PCH-7 deleted ClientHeadless; all
//!    attach/subscribe/resync/snapshot now serialize the SHARED
//!    `session._headless`, written live at the current PTY dims.
//!
//! 3. **Don't attempt to reflow cursor-positioned TUI output.**
//!    See #2. There is no per-client reflow that works for a full
//!    TUI app.
//!
//! # Bounds
//!
//! `MIN_COLS`/`MIN_ROWS`/`MAX_COLS`/`MAX_ROWS` are defensive caps
//! on untrusted resize input (arriving over the WS protocol, which
//! slice 9d will carry). Node's WS message validator (scar
//! `9dc7c78`) rejected rows/cols > 1000 — we port the same ceiling.
//! The floor catches pathological zero/negative values after any
//! future arithmetic that could underflow.
//!
//! # Default dimensions for newly-spawned sessions
//!
//! `DEFAULT_COLS`/`DEFAULT_ROWS` are used when tmux spawns a
//! session before any client has reported its actual window size.
//! 80×24 is the compatibility choice — every TUI app in existence
//! has been tested at those dims, and any sensible client reports
//! its real size within milliseconds of attaching.

/// Minimum columns — below this the display is useless for any
/// terminal app. Rejecting smaller values avoids arithmetic edge
/// cases inside tmux and curses programs.
pub const MIN_COLS: u16 = 10;
/// Minimum rows — a single-line terminal is technically valid but
/// breaks full-screen programs catastrophically. 3 gives status
/// line + command line + one line of output, which is the smallest
/// shape where anything is usable.
pub const MIN_ROWS: u16 = 3;
/// Maximum columns, clamping untrusted client input. Ported from
/// Node's WS validator (scar `9dc7c78`).
pub const MAX_COLS: u16 = 1000;
/// Maximum rows. Same source.
pub const MAX_ROWS: u16 = 1000;

/// Default columns for a freshly-created session before any client
/// has reported its real window size.
pub const DEFAULT_COLS: u16 = 80;
/// Default rows. Pairs with `DEFAULT_COLS`.
pub const DEFAULT_ROWS: u16 = 24;

/// Clamp a client-reported dimension pair to the defensive bounds.
/// Returns the clamped (cols, rows). Not a validation function —
/// it never errors — because clamping is the right answer for
/// every out-of-range value: too small → MIN, too large → MAX.
/// Callers that want to distinguish "clamped" from "accepted"
/// should compare input to output themselves.
pub fn clamp_dims(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(MIN_COLS, MAX_COLS), rows.clamp(MIN_ROWS, MAX_ROWS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_dims_clips_to_bounds() {
        assert_eq!(clamp_dims(80, 24), (80, 24));
        assert_eq!(clamp_dims(0, 0), (MIN_COLS, MIN_ROWS));
        assert_eq!(clamp_dims(9999, 9999), (MAX_COLS, MAX_ROWS));
        assert_eq!(clamp_dims(5, 2), (MIN_COLS, MIN_ROWS));
        assert_eq!(clamp_dims(1001, 500), (MAX_COLS, 500));
    }

    #[test]
    fn defaults_are_within_bounds() {
        // Sanity: the defaults we ship with must themselves pass
        // the clamp — otherwise a fresh session would already be
        // malformed by our own rules.
        assert_eq!(
            clamp_dims(DEFAULT_COLS, DEFAULT_ROWS),
            (DEFAULT_COLS, DEFAULT_ROWS)
        );
    }
}
