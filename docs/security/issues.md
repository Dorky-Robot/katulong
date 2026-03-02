# Security Audit Findings — March 2026

Audit performed on `katulong-mini.felixflor.es` and `katulong-og.felixflor.es`.

**Result: No critical vulnerabilities.** An unauthenticated attacker cannot gain terminal access. All findings below are hardening improvements.

---

## MEDIUM-1: HTTP Server Binds to 0.0.0.0

- **File:** `server.js:334`
- **Status:** Fixed
- **Issue:** HTTP server binds to all interfaces (`0.0.0.0`), exposing it on LAN. SSH server correctly binds to `127.0.0.1`.
- **Fix:** Bind to `127.0.0.1` by default. Add `KATULONG_BIND_HOST` env var for explicit override.

## MEDIUM-2: Session Tokens Used as Filenames

- **File:** `lib/auth.js:287-293`
- **Status:** Fixed
- **Issue:** Raw session tokens are used as filenames in `DATA_DIR/sessions/`. Filesystem read access exposes all tokens.
- **Fix:** Use `SHA-256(token)` as filename. Store token inside the file. Handle migration from old format.

## LOW-1: No HSTS Header

- **File:** `lib/request-util.js:64-70`
- **Status:** Fixed
- **Issue:** Neither instance sends `Strict-Transport-Security`. Allows protocol downgrade attacks.
- **Fix:** Add HSTS header when connection is HTTPS.

## LOW-2: CSP Relaxed Based on Forgeable Headers

- **File:** `lib/http-util.js:183-195`
- **Status:** Fixed
- **Issue:** CSP widened for Cloudflare based on `cf-ray`/`cf-visitor`/`cf-connecting-ip` headers, which are forgeable.
- **Fix:** Only check CF headers when `req.socket.remoteAddress` is loopback.

## LOW-3: Upload Endpoint Returns Absolute Filesystem Path

- **File:** `lib/routes.js:602`
- **Status:** Fixed
- **Issue:** `POST /upload` response includes `absolutePath` leaking server directory structure.
- **Fix:** Remove `absolutePath` from response.

## INFO-1: Health Endpoint Exposes PID and Uptime

- **File:** `lib/routes.js:531-541`
- **Status:** Fixed
- **Issue:** Public `/health` endpoint returns PID and uptime to unauthenticated users.
- **Fix:** Return only `status` and `daemonConnected` for unauthenticated requests. Include full details for authenticated requests.

## INFO-2: HTTP Served Without HTTPS Redirect (Cloudflare Config)

- **Status:** External (Cloudflare dashboard)
- **Issue:** Both instances serve login page over plain HTTP without redirect to HTTPS.
- **Fix:** Enable "Always Use HTTPS" in Cloudflare dashboard. Not a code fix.
