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
- `lib/ssh.js` — SSH server bridging native terminals to daemon PTY sessions
- `lib/ndjson.js` — Newline-delimited JSON encode/decode for daemon IPC

## Development principles

### Boy Scout Rule
**Always leave the codebase better than you found it.**

When encountering issues unrelated to your current task:
- Fix flaky tests rather than skipping them
- Add missing error handling instead of ignoring failures
- Improve documentation when you notice gaps
- Refactor confusing code when you touch it

Technical debt should be addressed opportunistically, not deferred indefinitely. If a fix takes less than 30 minutes and improves code quality or reliability, do it as part of your current work.

### Testing and Git Workflow

**NEVER use `git push --no-verify` or `git commit --no-verify`.** This defeats the entire purpose of having tests and pre-commit/pre-push hooks.

If tests are failing or hooks are blocking your push:
1. **Fix the actual problem** — don't bypass the safety check
2. **Stop conflicting processes** — if e2e tests can't start the server, find and kill the process using the port
3. **Fix flaky tests** — if tests fail intermittently, debug and fix them rather than skipping
4. **Address test gaps** — if tests should catch a bug but don't, add the missing test coverage

The pre-push hook runs the full test suite including e2e tests. This is your last line of defense against shipping broken code. Bypassing it means bugs reach production.

**Common issues and fixes:**
- **Port conflict (EADDRINUSE)**: Stop background servers before pushing: `lsof -ti:3002 | xargs kill -9`
- **E2E timeout**: Ensure no dev servers are running on test ports (3001, 3002)
- **Failing tests**: Fix the test or the code — never skip the test

**There are NO exceptions.** Never use `--no-verify`, `SKIP_REVIEW=1`, or any other mechanism to bypass hooks. If hooks are slow, fix the hooks. If tests are flaky, fix the tests. If agents timeout, optimize the pipeline. The solution is never to skip the safety check.

### Pull Request Workflow

**ALWAYS create a pull request instead of pushing directly to `main`.**

When implementing features or fixes:
1. Create a feature branch: `git checkout -b feature/descriptive-name`
2. Make your changes and commit
3. Push the branch: `git push -u origin feature/descriptive-name`
4. Create a pull request for review
5. Wait for approval before merging to main

This ensures:
- Code review before merging
- Clear history of what changed and why
- Ability to discuss implementation decisions
- Easy rollback if issues are discovered

**Exception**: Only push directly to main for urgent hotfixes that are already tested and reviewed.

## Security model

**This application provides direct terminal access to the host.** Every code change must be reviewed with this in mind.

### Authentication
- First device registers via WebAuthn (passkey). Subsequent devices pair via QR code + 6-digit PIN.
- Localhost requests (`127.0.0.1`, `::1`) bypass auth (auto-authenticated).
- LAN/remote requests require a valid `katulong_session` cookie.
- Sessions are 30-day tokens stored server-side. Expired sessions are pruned.
- SSH access authenticates via password (`SSH_PASSWORD` or `SETUP_TOKEN`). Username maps to session name.

### Authorization boundaries
- `isPublicPath()` in `lib/http-util.js` controls which routes skip auth. Any change here is security-critical.
- WebSocket upgrade validates the session cookie. Unauthenticated upgrades are rejected.
- The daemon trusts all messages from the server process (no per-message auth on the Unix socket).

### Threat surface
- **Auth bypass**: Any route that serves content or accepts input without checking `isAuthenticated()` is a direct shell access vulnerability.
- **Session hijacking**: Cookie flags (HttpOnly, SameSite=Lax) must be maintained. No session tokens in URLs or localStorage. Auth state files use atomic writes (temp + rename) to prevent corruption. All session state mutations must use `withStateLock()` to prevent race conditions.
- **Command injection**: Terminal input goes directly to a PTY. The server must never interpolate user data into shell commands on the server side. Sensitive env vars (SSH_PASSWORD, SETUP_TOKEN) are filtered from PTY environments.
- **Path traversal**: Static file serving resolves paths against `public/` and checks the prefix. `isPublicPath()` rejects paths with `..`, `//`, or leading dots to prevent traversal. Changes to static file handling must maintain these checks.
- **Pairing flow**: Pairing codes are short-lived (30s), single-use, and validated (UUID format for code, exactly 6 digits for PIN). PIN brute-force is mitigated by expiry. The pairing endpoint (`POST /auth/pair/start`) requires authentication.
- **XSS**: The frontend is a single HTML file with no templating. Any server-side HTML injection (e.g., `data-` attribute interpolation) must escape user-controlled values via `escapeAttr()`.
- **SSH access**: Password compared via `timingSafeEqual`. Host key persisted to `DATA_DIR/ssh/`. SSH port should be firewalled on untrusted networks.
- **WebSocket origin**: Origin header validated on WS upgrade — must match Host header for non-localhost requests. Rejects missing or mismatched origins.
- **TLS**: LAN HTTPS uses auto-generated self-signed certs. The CA cert must never be served without user intent. Only actual TLS socket state (`req.socket.encrypted`) is trusted, never `X-Forwarded-Proto` header.
- **Request body size**: All public auth endpoints enforce 1MB request body limit to prevent DoS attacks.
- **Supply chain security**: All frontend dependencies are self-hosted in `public/vendor/` to eliminate CDN trust. No external JavaScript is loaded at runtime.

## Code review checklist

When reviewing PRs, pay close attention to:

1. **Auth changes**: Any modification to `isAuthenticated()`, `isPublicPath()`, `isLocalRequest()`, session validation, or cookie handling
2. **New routes**: Every new HTTP route must either be in `isPublicPath()` (with justification) or protected by the auth middleware
3. **WebSocket handling**: Origin validation must be maintained. New message types must not allow unauthenticated actions.
4. **Input handling**: Server-side code must never pass unsanitized input to `child_process`, `exec`, or similar. Validate all input formats (UUIDs, PINs, etc.).
5. **Static file serving**: The `filePath.startsWith(publicDir)` guard must not be weakened. Path traversal checks in `isPublicPath()` must remain strict.
6. **Request body handling**: All public endpoints must use `readBody()` with size limits (max 1MB for auth endpoints).
7. **Dependency changes**: New dependencies increase attack surface — flag additions for review. Prefer self-hosting in `public/vendor/` over CDN imports.
8. **Frontend security**: No `innerHTML` with user-controlled data, no eval, no dynamic script injection from user input. Use `escapeAttr()` for HTML attribute injection.
9. **Pairing flow**: Pairing challenges must remain time-limited, single-use, and format-validated.
10. **Error handling**: Error responses must not leak internal paths, stack traces, or secrets.
11. **File I/O**: Auth state writes must be atomic (temp + rename). Add error handling for corrupt JSON.
12. **Environment variables**: Never expose sensitive env vars (SSH_PASSWORD, SETUP_TOKEN, KATULONG_NO_AUTH) to PTY processes.
13. **Header trust**: Never trust request headers (`X-Forwarded-*`) for security decisions. Only trust actual socket state.
14. **State mutations**: All auth state mutations must use `withStateLock()` from `lib/auth.js` to prevent race conditions.

## Testing

```
npm test          # all tests
npm run test:unit # unit tests only
npm run test:integration # daemon integration tests
```

Tests live in `test/`. The test suite covers auth, session management, cookie parsing, daemon IPC, and the NDJSON protocol.

## Security history

See `SECURITY_IMPROVEMENTS.md` for documentation of major security hardening completed in February 2026, which addressed 86 code review findings including request body DoS protection, header trust removal, atomic file operations, path traversal protection, session race conditions, input validation, environment filtering, and supply chain security via self-hosted dependencies.
