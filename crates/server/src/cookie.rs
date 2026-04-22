//! Session cookie primitives.
//!
//! One cookie name (`katulong_session`), one set of flags, one parser.
//! All flag decisions are centralised here so "what flags does the session
//! cookie carry?" has one answer visible to every reviewer. The equivalent
//! logic in the Node implementation drifted across three files before
//! being consolidated (commit `7b3bb1b` in Node tracked the pain); this
//! file exists to prevent the same drift in Rust.

/// The HTTP cookie name that carries the session token.
///
/// Fixed string — never construct this ad-hoc at a call site, because a
/// typo or case-mismatch will silently authenticate no one.
pub const SESSION_COOKIE: &str = "katulong_session";

/// Extract the session token from the `Cookie:` header value, if present.
///
/// HTTP allows multiple cookies separated by `;` with optional whitespace.
/// We parse the whole header and pick out our named cookie, rather than
/// trusting the ordering or the presence of a trailing `;`. Returns `None`
/// on any parse failure — a malformed cookie header is indistinguishable
/// from a missing one at the auth boundary. Caller treats both as
/// "unauthenticated."
pub fn extract_session_token(header_value: &str) -> Option<String> {
    for pair in header_value.split(';') {
        let pair = pair.trim();
        if let Some((name, value)) = pair.split_once('=') {
            if name.trim() == SESSION_COOKIE {
                // Trim the value too — some clients emit
                // `katulong_session=TOKEN ; next=1` where the space before
                // the semicolon lands inside the value. Our tokens are
                // hex-only so whitespace can never be a real value, and a
                // trimmed mismatch (`"TOKEN "` vs `"TOKEN"`) would silently
                // 401 an authenticated user.
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// Build the `Set-Cookie` header value for a freshly minted session.
///
/// Flags:
/// - `HttpOnly` — the cookie is never readable from JavaScript, so an XSS
///   on a terminal line doesn't hand the attacker a session.
/// - `SameSite=Lax` — top-level navigations send the cookie (needed for
///   the OAuth-style redirect flow after WebAuthn), but cross-site POSTs
///   don't (blocks CSRF on state-changing endpoints that don't do their
///   own CSRF check yet).
/// - `Secure` — set when `secure` is true, i.e. remote (tunnel) access.
///   We intentionally omit it for loopback traffic so dev over
///   `http://localhost` still works.
/// - `Path=/` — the session is valid for every route on the origin.
/// - `Max-Age` — expressed in seconds; the client drops the cookie when
///   it elapses, matching the server-side `expires_at` on the `Session`.
///
/// The token is written verbatim — no URL-escaping is needed since our
/// tokens are hex-only. If the token format ever changes, the caller is
/// responsible for encoding it; a change here without one there would
/// silently produce cookies the client can't send back.
pub fn build_set_cookie(token: &str, max_age_secs: u64, secure: bool) -> String {
    format!(
        "{name}={token}; Max-Age={max_age_secs}{flags}",
        name = SESSION_COOKIE,
        flags = cookie_flags(secure),
    )
}

/// Build a `Set-Cookie` header that clears the session cookie.
///
/// Same name + path as the live cookie (otherwise the browser won't
/// overwrite it), `Max-Age=0` to evict immediately. The value is empty
/// but still present — omitting it entirely would be a malformed
/// `Set-Cookie`. `Secure` follows the live cookie's setting so the
/// browser is willing to overwrite on the right scheme.
pub fn build_clear_cookie(secure: bool) -> String {
    format!(
        "{name}=; Max-Age=0{flags}",
        name = SESSION_COOKIE,
        flags = cookie_flags(secure),
    )
}

/// The canonical flag block. Returns the suffix that every `Set-Cookie`
/// we emit must carry: `HttpOnly`, `SameSite=Lax`, `Path=/`, and
/// conditional `Secure`. Lives as a private helper so the module's
/// stated "one flag list" guarantee is structural: adding a flag
/// (e.g. `Partitioned` or the `__Host-` prefix if we ever adopt it)
/// is a single-site change rather than "remember both emitters."
fn cookie_flags(secure: bool) -> String {
    let mut s = String::from("; HttpOnly; SameSite=Lax; Path=/");
    if secure {
        s.push_str("; Secure");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_pulls_named_cookie_from_multi_cookie_header() {
        let header = "other=foo; katulong_session=abc123; yet_another=bar";
        assert_eq!(
            extract_session_token(header),
            Some("abc123".to_string()),
            "must locate the session cookie regardless of position"
        );
    }

    #[test]
    fn extract_handles_whitespace_variants() {
        assert_eq!(
            extract_session_token("katulong_session=t"),
            Some("t".to_string())
        );
        assert_eq!(
            extract_session_token("   katulong_session=t  "),
            Some("t".to_string())
        );
        assert_eq!(
            extract_session_token("a=1;katulong_session=t;b=2"),
            Some("t".to_string())
        );
    }

    #[test]
    fn extract_returns_none_when_absent() {
        assert_eq!(extract_session_token(""), None);
        assert_eq!(extract_session_token("a=1; b=2"), None);
        assert_eq!(
            extract_session_token("katulong_session_other=decoy"),
            None,
            "a similar-but-not-identical name must not match"
        );
    }

    #[test]
    fn extract_trims_whitespace_from_value() {
        // Clients sometimes emit `katulong_session=TOKEN ; next=1` where
        // the space before `;` lands inside the value. Hex tokens can't
        // legitimately contain whitespace, and a non-trimmed mismatch
        // silently 401s an authenticated user.
        assert_eq!(
            extract_session_token("katulong_session=abc123 ; other=1"),
            Some("abc123".to_string())
        );
        assert_eq!(
            extract_session_token("katulong_session=  abc123  "),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn extract_returns_none_on_malformed_pairs() {
        // A pair without `=` is silently skipped rather than erroring out —
        // robustness: the auth middleware treats "no session" as
        // "unauthenticated," and that's the correct fallback for a
        // degenerate header too.
        assert_eq!(extract_session_token("no_equals_here"), None);
        assert_eq!(
            extract_session_token("no_equals; katulong_session=t"),
            Some("t".into()),
            "one malformed pair must not poison the rest"
        );
    }

    #[test]
    fn build_sets_secure_only_when_requested() {
        let remote = build_set_cookie("abc", 60, true);
        assert!(remote.contains("Secure"), "remote cookies must be Secure");
        let local = build_set_cookie("abc", 60, false);
        assert!(
            !local.contains("Secure"),
            "loopback cookies must not carry Secure — blocks dev over http://"
        );
    }

    #[test]
    fn build_always_sets_httponly_and_samesite() {
        for secure in [true, false] {
            let c = build_set_cookie("t", 60, secure);
            assert!(c.contains("HttpOnly"), "HttpOnly must be present");
            assert!(c.contains("SameSite=Lax"), "SameSite=Lax must be present");
            assert!(c.contains("Path=/"), "Path=/ must be present");
        }
    }

    #[test]
    fn clear_cookie_uses_max_age_zero() {
        let c = build_clear_cookie(true);
        assert!(c.starts_with("katulong_session=;"));
        assert!(c.contains("Max-Age=0"));
        assert!(c.contains("Secure"));
    }
}
