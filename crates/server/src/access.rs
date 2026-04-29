//! Access-method detection: localhost vs remote.
//!
//! Critical security boundary. Localhost requests bypass WebAuthn because
//! local shell access is already root-equivalent; remote requests must
//! present a valid session cookie. Mis-classifying a tunnel connection as
//! localhost would hand the internet a free shell.
//!
//! The Node implementation learned the hard way (commit `fb4b1f9`) that
//! a loopback SOCKET address alone isn't enough — Cloudflare Tunnel and
//! ngrok both bridge traffic through a local cloudflared/ngrok process,
//! so the server sees `127.0.0.1` as the peer address even for traffic
//! originating on the public internet. The fix is to require BOTH a
//! loopback peer AND a Host header pointing at `localhost` / `127.0.0.1`
//! / `::1`. If either condition fails, treat as remote.
//!
//! Note on `X-Forwarded-*`: we deliberately do not consult forwarded
//! headers here. They are trivially forgeable and trusting them is the
//! exact class of bug `c37c2c0` in Node flagged.

use std::net::{IpAddr, SocketAddr};

/// Access classification for a single HTTP request.
///
/// `Remote` is the safe default: any ambiguity falls this way so the
/// auth middleware demands a cookie rather than silently bypassing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMethod {
    /// Both the peer address AND the Host header resolve to loopback.
    /// Auth bypass is safe — the peer is this machine.
    Localhost,
    /// Anything else. Requires a valid session cookie.
    Remote,
}

impl AccessMethod {
    /// Classify a request from its socket peer address and `Host` header.
    ///
    /// `host_header` is the raw value (may include a port suffix like
    /// `localhost:3000`). Both checks must pass — loopback peer AND
    /// loopback host — for `Localhost`. Missing header → `Remote`.
    pub fn classify(peer: SocketAddr, host_header: Option<&str>) -> Self {
        if !peer.ip().is_loopback() {
            return Self::Remote;
        }
        if host_header.is_some_and(host_is_loopback) {
            Self::Localhost
        } else {
            Self::Remote
        }
    }
}

/// Boundary conversion from the server-internal access type
/// to its wire-format mirror. Lives here (not in `wire.rs`)
/// because the conversion direction is one-way at the
/// HTTP-response boundary, and putting it in the shared
/// crate would require an upstream dep on the server crate.
/// Centralising the match here means a future variant
/// addition gets caught by the exhaustive-match warning at
/// one site instead of N inline matches across handlers.
impl From<AccessMethod> for katulong_shared::wire::AccessMethod {
    fn from(value: AccessMethod) -> Self {
        match value {
            AccessMethod::Localhost => Self::Localhost,
            AccessMethod::Remote => Self::Remote,
        }
    }
}

/// Strip any `:port` from a Host header and test whether the remaining
/// authority is a loopback hostname or literal loopback IP.
///
/// Accepts the obvious literals (`localhost`, `127.0.0.1`, `::1`) and any
/// IPv4 in `127.0.0.0/8` — the full loopback range, not just the
/// single-address one, since `127.0.0.2` etc. are valid loopback aliases
/// on most platforms and a test rig may use them.
fn host_is_loopback(header: &str) -> bool {
    let authority = strip_port(header);
    if authority.eq_ignore_ascii_case("localhost") {
        return true;
    }
    authority.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Strip a trailing `:port` from a host authority, if any. Must handle
/// both bracketed IPv6 (`[::1]:3000`) and plain IPv4/hostname forms.
fn strip_port(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        // IPv6 literal: `[::1]:3000` → pull the inner `::1`.
        if let Some((addr, _)) = rest.split_once(']') {
            return addr;
        }
    }
    // Plain form. For hostnames and IPv4 `a.b.c.d:port` works on the
    // last `:`. For bare IPv6 without brackets the browser wouldn't send
    // the port anyway (RFC 7230 requires brackets) so we can treat the
    // whole string as the authority.
    authority.rsplit_once(':').map_or(authority, |(host, _)| host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sa(ip: &str, port: u16) -> SocketAddr {
        format!("{ip}:{port}").parse().unwrap()
    }

    #[test]
    fn loopback_peer_plus_loopback_host_is_localhost() {
        let cases = [
            ("127.0.0.1", Some("localhost")),
            ("127.0.0.1", Some("localhost:3000")),
            ("127.0.0.1", Some("127.0.0.1:3000")),
            ("127.0.0.1", Some("LOCALHOST")),
            ("::1", Some("[::1]:3000")),
        ];
        for (peer_ip, host) in cases {
            let peer = if peer_ip.contains(':') {
                format!("[{peer_ip}]:9999").parse().unwrap()
            } else {
                sa(peer_ip, 9999)
            };
            assert_eq!(
                AccessMethod::classify(peer, host),
                AccessMethod::Localhost,
                "peer={peer_ip} host={host:?}"
            );
        }
    }

    #[test]
    fn loopback_peer_with_tunnel_host_is_remote() {
        // This is THE scar. Cloudflare Tunnel bridges traffic through a
        // local cloudflared, so peer == 127.0.0.1 even for internet
        // traffic. Must not classify as localhost.
        let cases = [
            Some("katulong.example.com"),
            Some("abc123.trycloudflare.com"),
            Some("katulong-mini.felixflor.es"),
            None, // No host header at all — treat as remote.
        ];
        for host in cases {
            assert_eq!(
                AccessMethod::classify(sa("127.0.0.1", 9999), host),
                AccessMethod::Remote,
                "loopback peer + {host:?} must be Remote"
            );
        }
    }

    #[test]
    fn non_loopback_peer_is_always_remote() {
        assert_eq!(
            AccessMethod::classify(sa("192.168.1.10", 9999), Some("localhost")),
            AccessMethod::Remote,
            "even a localhost Host header cannot override a non-loopback peer"
        );
    }

    #[test]
    fn strip_port_handles_ipv6_brackets() {
        assert_eq!(strip_port("[::1]:3000"), "::1");
        assert_eq!(strip_port("[::1]"), "::1");
        assert_eq!(strip_port("localhost:3000"), "localhost");
        assert_eq!(strip_port("localhost"), "localhost");
        assert_eq!(strip_port("127.0.0.1:80"), "127.0.0.1");
    }

    #[test]
    fn full_127_loopback_range_is_loopback() {
        // `127.0.0.2` and friends are valid loopback on most systems.
        assert!(host_is_loopback("127.0.0.2"));
        assert!(host_is_loopback("127.255.255.254"));
    }
}
