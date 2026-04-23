//! Small helpers for safely rendering attacker-controlled strings
//! into `tracing` log lines.
//!
//! Any field value that originated from the network — an Origin
//! header, a `HelloAck.protocol_version`, a raw session name — can
//! contain embedded newlines, ANSI control sequences, or arbitrary
//! length. Emitting those verbatim lets an attacker forge log
//! lines (CR/LF injection), hijack JSON-formatter structured
//! fields (`"field":"value"\n{"level":"ERROR",...}`), or flood
//! disks (`Origin: <1 MB>`). This module centralises the guard
//! so every reject site uses the same sanitizer; before it
//! existed there were two near-identical copies in `ws.rs` and
//! `session::handler`.

/// Strip ASCII control characters and cap length. Returns a new
/// `String` safe to interpolate into a text-formatted log line or a
/// JSON-formatter structured field.
///
/// `max_len` is the hard cap — chosen by the caller based on what's
/// reasonable for the field. Typical values are 32 for short
/// identifiers (protocol version, session name) and 256 for
/// free-form headers (Origin) where a slightly longer prefix helps
/// operators identify legitimate mismatches.
///
/// Keeps only printable ASCII-visible + Unicode non-control chars.
/// We reject ALL `is_ascii_control()` chars, not just CR/LF,
/// because any C0 control can corrupt a text log or structured
/// field. Unicode controls above U+007F are left intact — they're
/// allowed by serde for string fields, and stripping them would
/// mangle legitimate non-ASCII content without providing an
/// injection defense (non-ASCII doesn't confuse log formatters).
pub fn sanitize_for_log(value: &str, max_len: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_ascii_control())
        .take(max_len)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_cr_lf() {
        // The classic log-injection: a crafted Origin or version
        // string that forges a new log line. CR/LF must never
        // survive sanitization.
        assert_eq!(
            sanitize_for_log("evil\r\n[WARN] faked=line", 256),
            "evil[WARN] faked=line"
        );
    }

    #[test]
    fn strips_tab_and_other_c0_controls() {
        // Tabs corrupt columnar log output; NUL corrupts C-string
        // loggers; any C0 control is unsafe.
        assert_eq!(
            sanitize_for_log("col\tumn\x00nul\x07bel", 256),
            "columnnulbel"
        );
    }

    #[test]
    fn caps_length() {
        // An attacker-chosen giant Origin shouldn't be able to
        // flood the log with a megabyte per request.
        let huge = "x".repeat(10_000);
        assert_eq!(sanitize_for_log(&huge, 256).len(), 256);
    }

    #[test]
    fn preserves_printable_ascii() {
        assert_eq!(
            sanitize_for_log("https://katulong.example/path?q=1", 256),
            "https://katulong.example/path?q=1"
        );
    }

    #[test]
    fn preserves_non_ascii_text() {
        // Non-ASCII characters are not attacker-useful for log
        // injection (log formatters are byte-safe above 0x7F).
        // Stripping them would mangle legitimate i18n content.
        let input = "hello 世界 🌏";
        assert_eq!(sanitize_for_log(input, 256), input);
    }

    #[test]
    fn empty_input_is_empty() {
        assert_eq!(sanitize_for_log("", 256), "");
    }

    #[test]
    fn max_len_zero_is_empty() {
        // Defensive: max_len of 0 must not panic and returns
        // empty. Callers that pass 0 are buggy, but graceful
        // handling avoids cascading failures.
        assert_eq!(sanitize_for_log("anything", 0), "");
    }
}
