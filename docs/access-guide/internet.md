# Internet Access

**URLs:**

- ngrok: `https://your-app.ngrok.app`
- Cloudflare Tunnel: `https://katulong.example.com`

The server itself binds to localhost only — the tunnel terminates TLS and forwards traffic to `127.0.0.1:3001`.

## Authentication: Setup Token + WebAuthn Passkey

### First Device Registration

1. **Generate Setup Token** (from localhost):
    - Access Katulong via localhost
    - Settings > Remote tab
    - Click "Generate New Token"
    - Enter device name (e.g., "iPhone")
    - Copy the token (shown only once — save it!)

2. **Register Passkey** (from internet URL):
    - Navigate to your tunnel URL
    - Click "Register New Passkey"
    - Paste the setup token
    - Click "Register with Passkey"
    - Use Touch ID / Face ID / security key
    - Device is now registered

3. **Login on Same Device:**
    - Navigate to your tunnel URL
    - Click "Login with Passkey"
    - Use Touch ID / Face ID / security key
    - Access granted

### Subsequent Device Registration

Either of:

1. **Setup Token** (from an authenticated session):
    - Settings > Remote tab (on any authenticated device)
    - Click "Generate New Token"
    - Same registration flow as the first device

2. **Device Approval:**
    - On the new device, choose "Request device authorization" from the login page
    - A 6-digit code appears on the new device
    - An already-authenticated device receives the request, verifies the code matches, and approves
    - The new device is signed in automatically (requests expire after 5 minutes)

### Why Setup Tokens?

- Prevents unauthorized registration when exposed to the internet
- Tokens are:
    - **Single-use** (revoked after one successful registration)
    - **Named** (you can see which token was used for which device)
    - **Revocable** (delete tokens before use to invalidate)
    - **Associated with credentials** (shows which passkey was registered with which token)

## Connection Types

### HTTP (Web Interface)

**Port:** `3001` (localhost only — remote access goes through the tunnel's HTTPS endpoint)

**Endpoints:**

| Path | Description |
|---|---|
| `/` | Main terminal interface |
| `/login` | Authentication page |
| `/auth/*` | Authentication API endpoints |
| `/api/*` | Protected API endpoints (sessions, devices, tokens) |

### WebSocket (Real-Time Terminal I/O)

**Upgrade Path:** `wss://` (via tunnel) or `ws://` (localhost)

Authentication flow:

1. HTTP > WebSocket Upgrade with session cookie
2. Server validates socket address, Host header, Origin header, session cookie, credential
3. Upgrade accepted — WebSocket attached with credentialId and sessionToken
4. **Continuous validation:** Session is re-validated periodically on WebSocket messages

**Message Types:**

- `attach` — Attach to PTY session
- `input` — Send input to PTY
- `resize` — Resize PTY dimensions
- `rtc-offer` / `rtc-ice-candidate` — WebRTC signaling for P2P DataChannel

### P2P DataChannel (WebRTC)

Low-latency terminal I/O that bypasses the server for data. Requires the optional `node-datachannel` package; if it's not installed or the connection fails, Katulong falls back transparently to WebSocket.

1. WebSocket signaling (offer/answer + ICE candidates)
2. Direct peer-to-peer DataChannel established
3. Falls back to WebSocket if P2P fails (firewall, NAT)

**Performance:**

| Scenario | Latency |
|---|---|
| Localhost P2P | ~1ms |
| Same-network P2P | ~5-10ms |
| Internet P2P | Varies |
| WebSocket fallback | +20-50ms overhead |

## Session Management

### Session Lifecycle

1. **Creation:** Generated during registration or login. 30-day expiry, random 32-character hex token.
2. **Storage:** Client cookie (`katulong_session`) + server-side JSON with session metadata.
3. **Validation:** Checked on every HTTP request, WebSocket upgrade, and periodically on WebSocket messages.
4. **Expiration:** Expired sessions removed, client receives 401 Unauthorized.
5. **Revocation:** Delete Credential > all sessions invalidated > WebSockets closed.

### Session Security

- **Credential Whitelist:** Sessions reference a credentialId; invalid if credential no longer exists
- **Immediate Revocation:** Deleting a credential closes all active WebSockets (code 1008)
- **State Locking:** All state mutations use `withStateLock()` mutex with atomic file writes

## Security Model

### Defense in Depth

Katulong implements multiple security layers:

**Network-Level:** Socket address + Host/Origin header validation, TLS via the tunnel, setup token for internet registration.

**Authentication:** FIDO2-compliant WebAuthn (phishing-resistant), single-use named setup tokens, device-approval flow with short-lived 6-digit codes.

**Session:** HttpOnly + SameSite=Lax + Secure cookies, server-side storage with credential whitelist, immediate revocation on credential delete.

**WebSocket:** Origin validation (prevents CSWSH), continuous session validation, connection closed immediately on revocation (code 1008).

**Input Validation:** Schema validation for all WebSocket messages, path traversal prevention, 1MB request body limit on public endpoints.

**Supply Chain:** All frontend dependencies self-hosted in `public/vendor/`, no CDN JavaScript at runtime.
