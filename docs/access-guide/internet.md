# Internet Access

**URLs:**

- ngrok: `https://your-app.ngrok.app`
- Cloudflare Tunnel: `https://katulong.example.com`
- Public IP: `https://1.2.3.4:3002`

## Authentication: Setup Token + WebAuthn Passkey

### First Device Registration

1. **Generate Setup Token** (from localhost or LAN):
    - Access Katulong via localhost or LAN
    - Settings > Remote tab
    - Click "Generate New Token"
    - Enter device name (e.g., "iPhone")
    - Copy the token (shown only once — save it!)

2. **Register Passkey** (from internet URL):
    - Navigate to `https://your-app.ngrok.app`
    - Click "Register New Passkey"
    - Paste the setup token
    - Click "Register with Passkey"
    - Use Touch ID / Face ID / security key
    - Device is now registered

3. **Login on Same Device:**
    - Navigate to `https://your-app.ngrok.app`
    - Click "Login with Passkey"
    - Use Touch ID / Face ID / security key
    - Access granted

### Subsequent Device Registration

1. **Generate Setup Token** (from authenticated session):
    - Settings > Remote tab (on any authenticated device)
    - Click "Generate New Token"
    - Copy the token

2. **Register New Device:**
    - Same flow as first device registration above

### Why Setup Tokens?

- Prevents unauthorized registration when exposed to the internet
- Tokens are:
    - **Single-use** (revoked after one successful registration)
    - **Named** (you can see which token was used for which device)
    - **Revocable** (delete tokens before use to invalidate)
    - **Associated with credentials** (shows which passkey was registered with which token)

## Connection Types

Katulong supports multiple connection protocols:

### HTTP/HTTPS (Web Interface)

**Ports:**

- HTTP: `3001` (public endpoints only + localhost)
- HTTPS: `3002` (all endpoints)

**Endpoints:**

| Path | Description |
|---|---|
| `/` | Main terminal interface |
| `/login` | Authentication page |
| `/pair?code=<UUID>` | LAN pairing page |
| `/auth/*` | Authentication API endpoints |
| `/api/*` | Protected API endpoints (sessions, devices, tokens) |
| `/connect/trust` | TLS certificate download (HTTP only) |

### WebSocket (Real-Time Terminal I/O)

**Upgrade Path:** `wss://` (HTTPS) or `ws://` (HTTP)

Authentication flow:

1. HTTP > WebSocket Upgrade with session cookie
2. Server validates socket address, Host header, Origin header, session cookie, credential
3. Upgrade accepted — WebSocket attached with credentialId and sessionToken
4. **Continuous validation:** Every WebSocket message re-validates the session

**Message Types:**

- `attach` — Attach to PTY session
- `input` — Send input to PTY
- `resize` — Resize PTY dimensions
- `p2p-signal` — WebRTC signaling for P2P DataChannel

### P2P DataChannel (WebRTC)

Low-latency terminal I/O that bypasses server for data:

1. WebSocket signaling (offer/answer + ICE candidates)
2. Direct peer-to-peer DataChannel established
3. Falls back to WebSocket if P2P fails (firewall, NAT)

**Performance:**

| Scenario | Latency |
|---|---|
| Localhost P2P | ~1ms |
| LAN P2P | ~5-10ms |
| Internet P2P | Varies |
| WebSocket fallback | +20-50ms overhead |

### SSH Access

**Port:** `2222`

```bash
ssh default@192.168.1.50 -p 2222
```

- **Password:** `SSH_PASSWORD` env var or `SETUP_TOKEN` env var
- **Username:** Maps to terminal session name
- Password compared via `timingSafeEqual` (constant-time comparison)
- Host key persisted to `~/.katulong/ssh/`
- Sensitive env vars filtered from PTY environments

## Session Management

### Session Lifecycle

1. **Creation:** Generated during registration or login. 30-day expiry, random 32-character hex token.
2. **Storage:** Client cookie (`katulong_session`) + server-side JSON with session metadata.
3. **Validation:** Checked on every HTTP request, WebSocket upgrade, and every WebSocket message.
4. **Expiration:** Expired sessions removed, client receives 401 Unauthorized.
5. **Revocation:** Delete Credential > all sessions invalidated > WebSockets closed.

### Session Security

- **Credential Whitelist:** Sessions reference a credentialId; invalid if credential no longer exists
- **Immediate Revocation:** Deleting a credential closes all active WebSockets (code 1008)
- **Continuous Validation:** Re-validated on every WebSocket message
- **State Locking:** All state mutations use `withStateLock()` mutex with atomic file writes

## Security Model

### Defense in Depth

Katulong implements multiple security layers:

**Network-Level:** Socket address + Host/Origin header validation, TLS encryption, setup token for internet registration.

**Authentication:** FIDO2-compliant WebAuthn (phishing-resistant), QR + PIN pairing for LAN (30-second expiry, single-use), single-use named setup tokens for internet.

**Session:** HttpOnly + SameSite=Lax + Secure cookies, server-side storage with credential whitelist, immediate revocation on credential delete.

**WebSocket:** Origin validation (prevents CSWSH), continuous session validation, connection closed immediately on revocation (code 1008).

**Input Validation:** Schema validation for all WebSocket messages, path traversal prevention, 1MB request body limit on public endpoints.

**Supply Chain:** All frontend dependencies self-hosted in `public/vendor/`, no CDN JavaScript at runtime.
