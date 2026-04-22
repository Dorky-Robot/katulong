//! tmux control-mode notification parser.
//!
//! tmux, when invoked with `-C`, speaks a line-oriented protocol on
//! stdout that this parser converts into `Notification` values. The
//! two framing constructs are:
//!
//! - Command replies: `%begin <time> <num> <flags>` then zero or more
//!   payload lines then `%end <time> <num> <flags>` (or `%error
//!   <time> <num> <flags>` followed by the error payload).
//! - Server events: single-line notifications like `%output %P data`,
//!   `%session-changed`, `%window-close`, `%exit`, etc.
//!
//! This module is deliberately syntax-only: it turns bytes into typed
//! values, it does not know about sessions, windows, panes, or the
//! SessionManager. The caller (`tmux.rs`) routes notifications to
//! their consumers — command replies to oneshot channels, `%output`
//! to whatever subscribes to a pane's byte stream, etc.
//!
//! Reference: `man tmux` → CONTROL MODE. Fields are space-separated;
//! payload lines between `%begin` and `%end` are verbatim (except
//! octal-escaped bytes, which we do NOT decode here — downstream
//! consumers that care about `%output` payloads need the raw form).

use std::num::ParseIntError;

/// A single parsed tmux-control-mode line.
///
/// `Payload` is not one of tmux's actual notifications — it's what
/// this parser emits for lines that sit between `%begin` and `%end`.
/// The stateful caller is responsible for grouping consecutive
/// `Payload`s into the command reply they belong to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    /// Start of a command reply. `num` is the sequence number
    /// assigned by tmux (the first command gets 0, increments from
    /// there). Callers match this to pending commands.
    Begin {
        time: u64,
        num: u32,
        flags: u32,
    },
    /// End of a successful command reply. Must match a prior `Begin`
    /// with the same `num`.
    End {
        time: u64,
        num: u32,
        flags: u32,
    },
    /// Command failed. Any payload lines between the matching
    /// `Begin` and this `Error` contain the error text.
    Error {
        time: u64,
        num: u32,
        flags: u32,
    },
    /// Byte stream from a pane. `pane_id` is the `%<digits>` ID
    /// (digits only — we strip the `%` prefix at parse time). `data`
    /// is the raw payload; tmux escapes control chars as `\ooo`
    /// (three-digit octal) but we don't decode here — consumers
    /// that need raw bytes will. Consumers that just need
    /// display-ready text can decode via the obvious inverse.
    Output {
        pane_id: u32,
        data: String,
    },
    /// `%session-changed $N name`
    SessionChanged {
        session_id: u32,
        name: String,
    },
    /// `%session-renamed name`
    SessionRenamed {
        name: String,
    },
    /// `%sessions-changed` (no args) — a session was added or
    /// removed.
    SessionsChanged,
    /// `%window-add @N`
    WindowAdd {
        window_id: u32,
    },
    /// `%window-close @N`
    WindowClose {
        window_id: u32,
    },
    /// `%window-renamed @N name`
    WindowRenamed {
        window_id: u32,
        name: String,
    },
    /// `%unlinked-window-close @N` — tmux 3.3+ alternate form.
    UnlinkedWindowClose {
        window_id: u32,
    },
    /// `%exit` or `%exit <reason>` — tmux is shutting the control
    /// connection down.
    Exit {
        reason: Option<String>,
    },
    /// A `%` notification whose keyword we don't recognize. Kept as
    /// a catch-all so unexpected tmux versions don't panic the
    /// parser — the caller can log-and-ignore.
    Unknown {
        keyword: String,
        rest: String,
    },
    /// A line that came between `Begin` and `End`/`Error`. Raw,
    /// unescaped bytes-as-UTF-8 (tmux sends UTF-8; consumers that
    /// need binary safety should pre-decode themselves).
    Payload(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("not a notification (missing % prefix): {0:?}")]
    NotNotification(String),
    #[error("malformed header: {0:?}")]
    MalformedHeader(String),
    #[error("field parse error: {0}")]
    FieldParse(#[from] ParseIntError),
}

/// Parse one line from tmux stdout. The caller is responsible for
/// having split the stream on `\n` already — `line` must not
/// contain the trailing newline.
///
/// Lines that don't start with `%` are treated as command-reply
/// payload and returned as `Notification::Payload`. The caller's
/// stateful grouping (inside `begin`/`end`) decides whether that
/// makes sense for the current position in the stream.
pub fn parse(line: &str) -> Result<Notification, ParseError> {
    // Anything not starting with `%` is treated as payload. The
    // caller's state machine decides whether we're actually inside
    // a `%begin`/`%end` block at this moment; the parser just
    // tags the line.
    let Some(rest) = line.strip_prefix('%') else {
        return Ok(Notification::Payload(line.to_string()));
    };

    // `%keyword rest-of-line`. tmux's keyword set is small and
    // well-known; we match on it directly.
    let (keyword, args) = rest.split_once(' ').unwrap_or((rest, ""));
    match keyword {
        "begin" => parse_begin_end(args).map(|(time, num, flags)| Notification::Begin {
            time,
            num,
            flags,
        }),
        "end" => parse_begin_end(args).map(|(time, num, flags)| Notification::End {
            time,
            num,
            flags,
        }),
        "error" => parse_begin_end(args).map(|(time, num, flags)| Notification::Error {
            time,
            num,
            flags,
        }),
        "output" => parse_output(args),
        "session-changed" => parse_session_changed(args),
        "session-renamed" => Ok(Notification::SessionRenamed {
            name: args.to_string(),
        }),
        "sessions-changed" => Ok(Notification::SessionsChanged),
        "window-add" => parse_at_window(args).map(|id| Notification::WindowAdd { window_id: id }),
        "window-close" => {
            parse_at_window(args).map(|id| Notification::WindowClose { window_id: id })
        }
        "window-renamed" => parse_window_renamed(args),
        "unlinked-window-close" => parse_at_window(args)
            .map(|id| Notification::UnlinkedWindowClose { window_id: id }),
        "exit" => Ok(Notification::Exit {
            reason: if args.is_empty() {
                None
            } else {
                Some(args.to_string())
            },
        }),
        other => Ok(Notification::Unknown {
            keyword: other.to_string(),
            rest: args.to_string(),
        }),
    }
}

fn parse_begin_end(args: &str) -> Result<(u64, u32, u32), ParseError> {
    let mut parts = args.split_whitespace();
    let time: u64 = parts
        .next()
        .ok_or_else(|| ParseError::MalformedHeader(args.to_string()))?
        .parse()?;
    let num: u32 = parts
        .next()
        .ok_or_else(|| ParseError::MalformedHeader(args.to_string()))?
        .parse()?;
    // flags is optional on some tmux versions; default to 0
    let flags: u32 = parts.next().unwrap_or("0").parse()?;
    Ok((time, num, flags))
}

fn parse_output(args: &str) -> Result<Notification, ParseError> {
    // `%P data-with-spaces-or-whatever`
    let (id_str, data) = args
        .split_once(' ')
        .ok_or_else(|| ParseError::MalformedHeader(args.to_string()))?;
    let id = strip_percent(id_str)?;
    Ok(Notification::Output {
        pane_id: id,
        data: data.to_string(),
    })
}

fn parse_session_changed(args: &str) -> Result<Notification, ParseError> {
    // `$N name`
    let (id_str, name) = args
        .split_once(' ')
        .ok_or_else(|| ParseError::MalformedHeader(args.to_string()))?;
    let id = strip_dollar(id_str)?;
    Ok(Notification::SessionChanged {
        session_id: id,
        name: name.to_string(),
    })
}

fn parse_at_window(args: &str) -> Result<u32, ParseError> {
    // `@N` — take the whole args, or if whitespace after, the first
    // token.
    let token = args.split_whitespace().next().unwrap_or(args);
    strip_at(token)
}

fn parse_window_renamed(args: &str) -> Result<Notification, ParseError> {
    let (id_str, name) = args
        .split_once(' ')
        .ok_or_else(|| ParseError::MalformedHeader(args.to_string()))?;
    let id = strip_at(id_str)?;
    Ok(Notification::WindowRenamed {
        window_id: id,
        name: name.to_string(),
    })
}

fn strip_percent(s: &str) -> Result<u32, ParseError> {
    let rest = s
        .strip_prefix('%')
        .ok_or_else(|| ParseError::MalformedHeader(s.to_string()))?;
    Ok(rest.parse()?)
}

fn strip_dollar(s: &str) -> Result<u32, ParseError> {
    let rest = s
        .strip_prefix('$')
        .ok_or_else(|| ParseError::MalformedHeader(s.to_string()))?;
    Ok(rest.parse()?)
}

fn strip_at(s: &str) -> Result<u32, ParseError> {
    let rest = s
        .strip_prefix('@')
        .ok_or_else(|| ParseError::MalformedHeader(s.to_string()))?;
    Ok(rest.parse()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_begin_end_error() {
        assert_eq!(
            parse("%begin 1701234567 42 1").unwrap(),
            Notification::Begin {
                time: 1_701_234_567,
                num: 42,
                flags: 1,
            }
        );
        assert_eq!(
            parse("%end 1701234567 42 1").unwrap(),
            Notification::End {
                time: 1_701_234_567,
                num: 42,
                flags: 1,
            }
        );
        assert_eq!(
            parse("%error 1701234567 42 1").unwrap(),
            Notification::Error {
                time: 1_701_234_567,
                num: 42,
                flags: 1,
            }
        );
    }

    #[test]
    fn parses_begin_without_flags_field() {
        // Older tmux versions omit the flags field. Default to 0
        // so we don't force every deployment onto a specific
        // release.
        assert_eq!(
            parse("%begin 100 7").unwrap(),
            Notification::Begin {
                time: 100,
                num: 7,
                flags: 0,
            }
        );
    }

    #[test]
    fn parses_output_with_embedded_spaces() {
        // The pane data can contain spaces, tabs, octal escapes,
        // anything. Parser preserves the whole remainder after the
        // first space following the pane id.
        let got = parse("%output %1 hello world  \\t\\n").unwrap();
        assert_eq!(
            got,
            Notification::Output {
                pane_id: 1,
                data: "hello world  \\t\\n".to_string(),
            }
        );
    }

    #[test]
    fn parses_session_changed() {
        assert_eq!(
            parse("%session-changed $3 work").unwrap(),
            Notification::SessionChanged {
                session_id: 3,
                name: "work".to_string(),
            }
        );
    }

    #[test]
    fn parses_window_events() {
        assert_eq!(
            parse("%window-add @5").unwrap(),
            Notification::WindowAdd { window_id: 5 }
        );
        assert_eq!(
            parse("%window-close @5").unwrap(),
            Notification::WindowClose { window_id: 5 }
        );
        assert_eq!(
            parse("%unlinked-window-close @5").unwrap(),
            Notification::UnlinkedWindowClose { window_id: 5 }
        );
        assert_eq!(
            parse("%window-renamed @5 bash").unwrap(),
            Notification::WindowRenamed {
                window_id: 5,
                name: "bash".to_string(),
            }
        );
    }

    #[test]
    fn parses_exit() {
        assert_eq!(
            parse("%exit").unwrap(),
            Notification::Exit { reason: None }
        );
        assert_eq!(
            parse("%exit server exited").unwrap(),
            Notification::Exit {
                reason: Some("server exited".to_string()),
            }
        );
    }

    #[test]
    fn payload_is_anything_not_starting_with_percent() {
        assert_eq!(
            parse("hello").unwrap(),
            Notification::Payload("hello".to_string())
        );
        assert_eq!(
            parse("").unwrap(),
            Notification::Payload(String::new())
        );
    }

    #[test]
    fn unknown_notification_survives_as_catch_all() {
        // Future tmux adds `%whatever`. We don't panic; we hand
        // the caller a Named+rest tuple so they can log-and-skip.
        let got = parse("%some-future-event arg1 arg2").unwrap();
        assert_eq!(
            got,
            Notification::Unknown {
                keyword: "some-future-event".to_string(),
                rest: "arg1 arg2".to_string(),
            }
        );
    }

    #[test]
    fn malformed_begin_errors_not_panics() {
        assert!(matches!(
            parse("%begin notanumber 42").unwrap_err(),
            ParseError::FieldParse(_)
        ));
    }
}
