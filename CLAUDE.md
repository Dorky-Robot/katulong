# Katulong

Katulong is a self-hosted web terminal that gives remote shell access to the host machine over HTTP + WebSocket. It runs locally (localhost-only) and remote access is provided via an external tunnel (ngrok, Cloudflare Tunnel, etc.). It manages terminal sessions via tmux and serves a single-page xterm.js frontend.

## Architecture

- `server.js` — HTTP + WebSocket server (routes, auth middleware, session management)
- `lib/session-manager.js` — Terminal session lifecycle via tmux control mode
- `lib/session.js` — Session class, tmux helpers, RingBuffer
- `public/index.html` — SPA frontend (xterm.js terminal, shortcut bar, settings)
- `lib/auth.js` — WebAuthn registration/login, session token management, passkey storage
- `lib/http-util.js` — Cookie parsing, public path allowlist, session cookies, challenge store


Remote access model: the server binds to localhost and an external tunnel tool (ngrok, Cloudflare Tunnel, etc.) forwards HTTPS traffic to it. TLS termination and external certificate management are handled by the tunnel, not by Katulong itself.

### Remote clipboard bridge

Image paste across machines (e.g., iPad → tunnel → Mac mini) requires a three-layer interception in `public/lib/paste-handler.js`: (1) block xterm's keydown `\x16`, (2) handle the paste event, (3) Clipboard API fallback for WebKit which suppresses paste after `preventDefault` on keydown. See `docs/clipboard-bridge.md` for the full architecture — **read it before modifying paste-handler.js, image-upload.js, or the upload route in routes.js**.

## Worktree-first workflow

**Always start work in a git worktree.** Before making any code changes, create a worktree so the main repo directory stays clean and available for parallel agents.

Use `git worktree add` (or the EnterWorktree tool in Claude Code) to create an isolated working copy for your branch. Do all development, commits, and pushes from the worktree. This allows multiple agents to work on different tasks simultaneously without conflicts in the main checkout.

## Codebase history search

Use `diwa search katulong "<query>"` to search the project's architectural history — past bugs, design decisions, patterns, and learnings indexed from commit history. Always search before tackling recurring issues (drag jitter, garbled text, scroll problems, etc.) to avoid repeating past mistakes.

## Development principles

### Boy Scout Rule
**Always leave the codebase better than you found it.**

When encountering issues unrelated to your current task:
- Fix flaky tests rather than skipping them
- Add missing error handling instead of ignoring failures
- Improve documentation when you notice gaps
- Refactor confusing code when you touch it

Technical debt should be addressed opportunistically, not deferred indefinitely. If a fix takes less than 30 minutes and improves code quality or reliability, do it as part of your current work.

### Commit Messages as Mini Blog Posts

Commit messages are the project's institutional memory. Write them like mini blog posts — not just what changed, but **why**, what was tried and failed, and what non-obvious lessons were learned. Future developers (and future AI agents) will use `diwa search` to find these learnings when facing similar problems.

A good commit message includes:
- **What changed** — bullet points of the actual code changes
- **Why** — the root cause of the bug or the motivation for the feature
- **What was tried and failed** — dead ends that future readers shouldn't repeat
- **Caveats and gotchas** — non-obvious interactions, platform quirks, timing issues
- **The key insight** — the one thing that made the fix work, stated clearly

Example: instead of "fix: touch drag jitter", write a message that explains that `e.preventDefault()` on touchstart is required because without it the browser initiates native scroll that fights with translate3d positioning, and that synthesized mouse events from touch arrive with different coordinates than the original touch events, and that the long-press-before-drag approach was tried but created worse jitter because the 300ms delay let native scroll establish itself.

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

### Authentication is MANDATORY — never add a way to disable it
- **NEVER add env vars, flags, config options, or any mechanism to disable or bypass authentication.** This app gives direct shell access to the host — disabling auth is equivalent to giving root access to anyone on the internet. This includes but is not limited to: `NO_AUTH`, `SKIP_AUTH`, `DISABLE_AUTH`, `AUTH_BYPASS`, or any similar pattern. The pre-commit hook will block any such attempt.
- First device registers via WebAuthn (passkey). Subsequent devices register via setup token + WebAuthn.
- Localhost requests (`127.0.0.1`, `::1`) bypass auth (auto-authenticated).
- Remote requests via tunnel require a valid `katulong_session` cookie.
- Sessions are 30-day tokens stored server-side. Expired sessions are pruned.


### Authorization boundaries
- `isPublicPath()` in `lib/http-util.js` controls which routes skip auth. Any change here is security-critical.
- WebSocket upgrade validates the session cookie. Unauthenticated upgrades are rejected.
- The session manager runs in-process with the server (no IPC boundary).

### Threat surface
- **Auth bypass**: Any route that serves content or accepts input without checking `isAuthenticated()` is a direct shell access vulnerability.
- **Session hijacking**: Cookie flags (HttpOnly, SameSite=Lax) must be maintained. No session tokens in URLs or localStorage. Auth state files use atomic writes (temp + rename) to prevent corruption. All session state mutations must use `withStateLock()` to prevent race conditions.
- **Command injection**: Terminal input goes directly to a PTY. The server must never interpolate user data into shell commands on the server side. Sensitive env vars (SETUP_TOKEN) are filtered from PTY environments.
- **Path traversal**: Static file serving resolves paths against `public/` and checks the prefix. `isPublicPath()` rejects paths with `..`, `//`, or leading dots to prevent traversal. Changes to static file handling must maintain these checks.
- **WebAuthn registration**: First device registers via passkey. Additional devices register via setup token (remote access flow).
- **XSS**: The frontend is a single HTML file with no templating. Any server-side HTML injection (e.g., `data-` attribute interpolation) must escape user-controlled values via `escapeAttr()`.

- **WebSocket origin**: Origin header validated on WS upgrade. For localhost connections, both socket address and Host/Origin headers are checked — a loopback socket address alone is not sufficient (tunnels like ngrok forward traffic from loopback). Rejects missing or mismatched origins on non-localhost requests.
- **Tunnel security**: Remote access relies on an external tunnel (ngrok, Cloudflare Tunnel, etc.) for TLS termination. The tunnel URL must be kept private; anyone with the URL can reach the login page. Katulong never trusts `X-Forwarded-Proto` or similar headers for security decisions — only actual socket state.
- **Request body size**: All public auth endpoints enforce 1MB request body limit to prevent DoS attacks.
- **Supply chain security**: All frontend dependencies are self-hosted in `public/vendor/` to eliminate CDN trust. No external JavaScript is loaded at runtime.

## Code review checklist

When reviewing PRs, pay close attention to:

1. **Auth changes**: Any modification to `isAuthenticated()`, `isPublicPath()`, `isLocalRequest()`, session validation, or cookie handling
2. **New routes**: Every new HTTP route must either be in `isPublicPath()` (with justification) or protected by the auth middleware
3. **WebSocket handling**: Origin validation must be maintained. New message types must not allow unauthenticated actions. Localhost detection must check both socket address and Host/Origin headers — a loopback socket alone is not sufficient (tunnel traffic arrives on loopback).
4. **Input handling**: Server-side code must never pass unsanitized input to `child_process`, `exec`, or similar. Validate all input formats (UUIDs, tokens, etc.).
5. **Static file serving**: The `filePath.startsWith(publicDir)` guard must not be weakened. Path traversal checks in `isPublicPath()` must remain strict.
6. **Request body handling**: All public endpoints must use `readBody()` with size limits (max 1MB for auth endpoints).
7. **Dependency changes**: New dependencies increase attack surface — flag additions for review. Prefer self-hosting in `public/vendor/` over CDN imports.
8. **Frontend security**: No `innerHTML` with user-controlled data, no eval, no dynamic script injection from user input. Use `escapeAttr()` for HTML attribute injection.
9. **WebAuthn flow**: Registration challenges must remain time-limited, single-use, and format-validated.
10. **Error handling**: Error responses must not leak internal paths, stack traces, or secrets.
11. **File I/O**: Auth state writes must be atomic (temp + rename). Add error handling for corrupt JSON.
12. **Environment variables**: Never expose sensitive env vars (SETUP_TOKEN) to PTY processes.
13. **Header trust**: Never trust request headers (`X-Forwarded-*`, `X-Forwarded-Proto`, etc.) for security decisions. Only trust actual socket state. This is especially important for tunnel-based access (ngrok, Cloudflare Tunnel) where reverse-proxy headers are trivially forgeable.
14. **Localhost detection**: `isLocalRequest()` in `lib/access-method.js` is security-critical — it gates auth bypass. It must check Host and Origin headers in addition to socket address to prevent tunnel traffic from being classified as local.
15. **State mutations**: All auth state mutations must use `withStateLock()` from `lib/auth.js` to prevent race conditions.

## Testing

```
npm test          # all tests
npm run test:unit # unit tests only
npm run test:integration # integration tests
```

Tests live in `test/`. The test suite covers auth, session management, cookie parsing, and tmux session lifecycle.

## Security history

See `docs/SECURITY_IMPROVEMENTS.md` for documentation of major security hardening completed in February 2026, which addressed 86 code review findings including request body DoS protection, header trust removal, atomic file operations, path traversal protection, session race conditions, input validation, environment filtering, and supply chain security via self-hosted dependencies.
