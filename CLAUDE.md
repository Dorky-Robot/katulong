# Katulong

Katulong is a self-hosted web terminal that gives remote shell access to the host machine over HTTP/HTTPS + WebSocket. It multiplexes PTY sessions via a Unix socket daemon and serves a single-page xterm.js frontend.

## Architecture

- `server.js` — HTTP/HTTPS + WebSocket server (routes, auth middleware, daemon IPC, device pairing)
- `daemon.js` — Long-lived process that owns PTY sessions, communicates over a Unix socket via NDJSON
- `public/index.html` — SPA frontend (xterm.js terminal, shortcut bar, settings, inline pairing wizard)
- `lib/auth.js` — WebAuthn registration/login, session token management, passkey storage
- `lib/http-util.js` — Cookie parsing, public path allowlist, session cookies, challenge store
- `lib/tls.js` — Auto-generated CA + server certificates for LAN HTTPS
- `lib/p2p.js` — WebRTC DataChannel for low-latency terminal I/O
- `lib/ndjson.js` — Newline-delimited JSON encode/decode for daemon IPC

## Security model

**This application provides direct terminal access to the host.** Every code change must be reviewed with this in mind.

### Authentication
- First device registers via WebAuthn (passkey). Subsequent devices pair via QR code + 6-digit PIN.
- Localhost requests (`127.0.0.1`, `::1`) bypass auth (auto-authenticated).
- LAN/remote requests require a valid `katulong_session` cookie.
- Sessions are 30-day tokens stored server-side. Expired sessions are pruned.

### Authorization boundaries
- `isPublicPath()` in `lib/http-util.js` controls which routes skip auth. Any change here is security-critical.
- WebSocket upgrade validates the session cookie. Unauthenticated upgrades are rejected.
- The daemon trusts all messages from the server process (no per-message auth on the Unix socket).

### Threat surface
- **Auth bypass**: Any route that serves content or accepts input without checking `isAuthenticated()` is a direct shell access vulnerability.
- **Session hijacking**: Cookie flags (HttpOnly, SameSite=Lax) must be maintained. No session tokens in URLs or localStorage.
- **Command injection**: Terminal input goes directly to a PTY. The server must never interpolate user data into shell commands on the server side.
- **Path traversal**: Static file serving resolves paths against `public/` and checks the prefix. Changes to static file handling must maintain this check.
- **Pairing flow**: Pairing codes are short-lived (30s) and single-use. PIN brute-force is mitigated by expiry. The pairing endpoint (`POST /auth/pair/start`) requires authentication.
- **XSS**: The frontend is a single HTML file with no templating. Any server-side HTML injection (e.g., `data-` attribute interpolation) must escape user-controlled values.
- **WebSocket origin**: Currently no origin check on WS upgrade — relies on cookie auth only.
- **TLS**: LAN HTTPS uses auto-generated self-signed certs. The CA cert must never be served without user intent.

## Code review checklist

When reviewing PRs, pay close attention to:

1. **Auth changes**: Any modification to `isAuthenticated()`, `isPublicPath()`, `isLocalRequest()`, session validation, or cookie handling
2. **New routes**: Every new HTTP route must either be in `isPublicPath()` (with justification) or protected by the auth middleware
3. **WebSocket handling**: New message types must not allow unauthenticated actions
4. **Input handling**: Server-side code must never pass unsanitized input to `child_process`, `exec`, or similar
5. **Static file serving**: The `filePath.startsWith(publicDir)` guard must not be weakened
6. **Dependency changes**: New dependencies increase attack surface — flag additions for review
7. **Frontend security**: No `innerHTML` with user-controlled data, no eval, no dynamic script injection from user input
8. **Pairing flow**: Pairing challenges must remain time-limited and single-use
9. **Error handling**: Error responses must not leak internal paths, stack traces, or secrets

## Testing

```
npm test          # all tests
npm run test:unit # unit tests only
npm run test:integration # daemon integration tests
```

Tests live in `test/`. The test suite covers auth, session management, cookie parsing, daemon IPC, and the NDJSON protocol.
