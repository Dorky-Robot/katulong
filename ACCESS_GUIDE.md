# Katulong Access Guide

Complete guide to accessing and authenticating with Katulong across different network environments.

---

## Table of Contents

1. [Overview](#overview)
2. [Three Access Methods](#three-access-methods)
3. [Initial Setup](#initial-setup)
4. [Access Method Details](#access-method-details)
5. [Connection Types](#connection-types)
6. [Session Management](#session-management)
7. [Security Model](#security-model)
8. [Troubleshooting](#troubleshooting)

---

## Overview

Katulong provides **secure remote terminal access** to your machine through multiple access methods, each optimized for different network environments. The system automatically detects how you're connecting and presents the appropriate authentication flow.

**Core Principle:** Localhost is trusted, LAN requires pairing, Internet requires passkeys.

---

## Three Access Methods

Katulong recognizes three distinct access methods based on how you connect:

| Access Method | Detection Criteria | Authentication Flow | Use Case |
|--------------|-------------------|---------------------|----------|
| **Localhost** | `127.0.0.1`, `::1`, `localhost` with matching Host header | Auto-authenticated (no login required) | Local development, direct access |
| **LAN** | Private IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x), `.local` mDNS domains | QR code + 8-digit PIN pairing | Same network access (home/office WiFi) |
| **Internet** | All other domains (ngrok, Cloudflare Tunnel, public IPs) | Setup token + WebAuthn passkey | Remote access over the internet |

### Access Method Detection Logic

The server determines access method using this priority order:

```javascript
function getAccessMethod(req) {
  if (isLocalRequest(req)) return "localhost";
  if (isLanRequest(req)) return "lan";
  return "internet";
}
```

**Localhost Detection** (`isLocalRequest`):
- Socket address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`)
- **AND** Host header matches localhost patterns (`localhost`, `127.0.0.1`, etc.)
- **AND** Origin header (if present) matches Host header
- **Security:** Blocks proxy bypass (e.g., ngrok tunneling localhost traffic)

**LAN Detection** (`isLanRequest`):
- Host header is mDNS `.local` domain (e.g., `katulong.local`)
- **OR** Host header is RFC 1918 private IP:
  - `10.0.0.0/8` (10.x.x.x)
  - `172.16.0.0/12` (172.16.x.x - 172.31.x.x)
  - `192.168.0.0/16` (192.168.x.x)
  - `169.254.0.0/16` (169.254.x.x - link-local)

**Internet Detection:**
- Everything else (public IPs, ngrok domains, Cloudflare Tunnel, etc.)

---

## Initial Setup

When you first launch Katulong, **no authentication is configured**. The initial setup flow differs based on how you access it:

### 1. Localhost Initial Setup

**URL:** `http://localhost:3001` or `https://localhost:3002`

**Flow:**
1. Auto-authenticated (no login required)
2. Access terminal immediately
3. Optional: Generate setup tokens for pairing other devices

**Why auto-authenticated?** If an attacker has localhost access, they already have full system access. No additional security layer helps.

### 2. LAN Initial Setup

**URL:** `https://192.168.x.x:3002` or `https://katulong.local:3002`

**Flow:**
1. Browser shows "Your connection is not private" (self-signed certificate)
2. Click "Advanced" → "Proceed to 192.168.x.x (unsafe)" to trust the certificate
3. First device must register via WebAuthn passkey:
   - Click "Register with Passkey"
   - Use Touch ID / Face ID / fingerprint
   - Device is now paired
4. Subsequent devices use QR + PIN pairing (see [LAN Access](#lan-access))

**Why HTTPS for LAN?** WebAuthn (passkeys) requires HTTPS. Katulong auto-generates self-signed certificates for LAN use.

**Trust the Certificate:**
- **One-time action** per device
- Certificate stored in `~/.katulong/tls/`
- Alternatively, access `/connect/trust` on HTTP port to download CA cert for system-wide trust

### 3. Internet Initial Setup

**URL:** `https://your-tunnel.ngrok.app` or public IP

**Flow:**
1. First device must use a **setup token**:
   - Generate token from localhost or LAN access
   - Settings → Remote → "Generate New Token"
   - Copy the token (shown only once)
2. Enter setup token on the login page
3. Register passkey (Touch ID / Face ID / security key)
4. Subsequent devices use new setup tokens (generated from authenticated session)

**Why setup tokens?** Prevents unauthorized registration when Katulong is exposed to the internet.

---

## Access Method Details

### Localhost Access

**URLs:**
- HTTP: `http://localhost:3001` or `http://127.0.0.1:3001`
- HTTPS: `https://localhost:3002` or `https://127.0.0.1:3002`

**Authentication:**
- **None required** - auto-authenticated
- No login page, no passkey, no pairing
- Direct access to terminal and settings

**Security:**
- Trusts socket address + Host header validation
- Rejects if Host header doesn't match (prevents proxy bypass)
- Rejects if Origin header mismatches (prevents tunnel bypass)

**Example Blocked Scenarios:**
```javascript
// Blocked: ngrok tunnel to localhost (proxy bypass attempt)
Socket: 127.0.0.1
Host: your-app.ngrok.app
→ Rejected (Host header doesn't match localhost patterns)

// Blocked: Mismatched origin
Socket: 127.0.0.1
Host: localhost
Origin: https://evil.com
→ Rejected (Origin doesn't match Host)
```

**Typical Workflow:**
1. Launch Katulong: `node server.js`
2. Open browser: `http://localhost:3001`
3. Terminal loads immediately
4. Generate setup tokens or pair LAN devices from Settings

---

### LAN Access

**URLs:**
- HTTPS: `https://192.168.1.50:3002` (example IP)
- HTTPS: `https://katulong.local:3002` (mDNS)
- HTTP: `http://192.168.1.50:3001` (limited - only for `/connect/trust` and public endpoints)

**Authentication: QR Code + 8-Digit PIN Pairing**

**Pairing Flow (Subsequent Devices):**

1. **Generate Pairing Code (on authenticated device):**
   - Open Settings → LAN tab
   - Click "Pair Device on LAN"
   - QR code and 8-digit PIN appear
   - Code is valid for **30 seconds**

2. **Scan QR Code (on new device):**
   - Open camera app and scan QR code
   - **OR** manually navigate to `https://192.168.1.50:3002/pair?code=<UUID>`

3. **Enter PIN:**
   - Enter the 8-digit PIN shown on the authenticated device
   - Click "Confirm"

4. **Device Paired:**
   - Session token stored in browser cookie
   - WebAuthn passkey registered (for this device)
   - Access granted to terminal

**Why QR + PIN for LAN?**
- **QR Code:** Transmits the pairing UUID securely (no typing long UUIDs)
- **8-Digit PIN:** Prevents unauthorized pairing even if someone sees the QR code
- **30-Second Expiry:** Limits attack window
- **Single-Use:** Each code can only be used once

**mDNS Discovery:**
- Katulong advertises as `katulong.local` via mDNS/Bonjour
- Accessible via `https://katulong.local:3002` on the local network
- Requires Avahi (Linux), Bonjour (macOS), or Bonjour Print Services (Windows)

**TLS Certificates:**
- Self-signed certificate auto-generated on first run
- Stored in `~/.katulong/tls/`
- Browser will warn about "not private" - this is expected
- Trust the certificate in system keychain for seamless access:
  - Access `http://192.168.1.50:3001/connect/trust`
  - Download `katulong-ca.crt`
  - Install in system keychain (instructions provided on page)

**Session Cookies:**
- `katulong_session` cookie stores 30-day session token
- `HttpOnly` flag prevents JavaScript access
- `SameSite=Lax` prevents CSRF attacks
- Secure flag set for HTTPS

---

### Internet Access

**URLs:**
- ngrok: `https://your-app.ngrok.app`
- Cloudflare Tunnel: `https://katulong.example.com`
- Public IP: `https://1.2.3.4:3002`

**Authentication: Setup Token + WebAuthn Passkey**

**First Device Registration:**

1. **Generate Setup Token (from localhost or LAN):**
   - Access Katulong via localhost or LAN
   - Settings → Remote tab
   - Click "Generate New Token"
   - Enter device name (e.g., "iPhone")
   - Copy the token (shown only once - save it!)

2. **Register Passkey (from internet URL):**
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

**Subsequent Device Registration:**

1. **Generate Setup Token (from authenticated session):**
   - Settings → Remote tab (on any authenticated device)
   - Click "Generate New Token"
   - Copy the token

2. **Register New Device:**
   - Same flow as first device registration above

**Why Setup Tokens?**
- Prevents unauthorized registration when exposed to the internet
- Tokens are:
  - **Single-use** (revoked after one successful registration)
  - **Named** (you can see which token was used for which device)
  - **Revocable** (delete tokens before use to invalidate)
  - **Associated with credentials** (shows which passkey was registered with which token)

**Passkey Storage:**
- Stored in the browser's WebAuthn credentials
- Synced via iCloud Keychain (Apple devices)
- Synced via Google Password Manager (Chrome/Android)
- Works across all devices signed into the same account

**Session Management:**
- 30-day session token stored in cookie
- Sessions tied to specific credentials
- Revoking a credential immediately closes all active sessions

---

## Connection Types

Katulong supports multiple connection protocols:

### 1. HTTP/HTTPS (Web Interface)

**Ports:**
- HTTP: `3001` (public endpoints only + localhost)
- HTTPS: `3002` (all endpoints)

**Endpoints:**
- `/` - Main terminal interface
- `/login` - Authentication page
- `/pair?code=<UUID>` - LAN pairing page
- `/auth/*` - Authentication API endpoints
- `/api/*` - Protected API endpoints (sessions, devices, tokens)
- `/connect/trust` - TLS certificate download (HTTP only)

**Session Authentication:**
- Protected endpoints require valid `katulong_session` cookie
- Sessions validated on every request
- Expired sessions return 401 Unauthorized

---

### 2. WebSocket (Real-Time Terminal I/O)

**Upgrade Path:** `wss://` (HTTPS) or `ws://` (HTTP)

**Authentication Flow:**

1. **HTTP → WebSocket Upgrade:**
   ```
   GET / HTTP/1.1
   Host: katulong.local:3002
   Origin: https://katulong.local:3002
   Cookie: katulong_session=<token>
   Upgrade: websocket
   ```

2. **Server Validates:**
   - Socket address (localhost, LAN, or internet)
   - Host header (must match access method)
   - **Origin header** (required for LAN/internet, must match Host)
   - Session cookie (for LAN/internet)
   - Credential still exists (not revoked)

3. **Upgrade Accepted:**
   ```
   HTTP/1.1 101 Switching Protocols
   Upgrade: websocket
   Connection: Upgrade
   ```

4. **WebSocket Attached:**
   - `ws.credentialId` attached for tracking
   - `ws.sessionToken` attached for re-validation
   - Added to active WebSocket clients map

**Continuous Session Validation:**
- **Every WebSocket message** re-validates the session
- If credential is revoked → WebSocket closed with code 1008 (Policy Violation)
- If session expires → WebSocket closed

**Message Types:**
- `attach` - Attach to PTY session
- `input` - Send input to PTY
- `resize` - Resize PTY dimensions
- `p2p-signal` - WebRTC signaling for P2P DataChannel

**Origin Validation (CSWSH Prevention):**
- WebSocket upgrade **requires** Origin header for non-localhost
- Origin must match Host header
- Prevents Cross-Site WebSocket Hijacking attacks

---

### 3. P2P DataChannel (WebRTC)

**Purpose:** Low-latency terminal I/O (bypasses server for data)

**Establishment Flow:**

1. **WebSocket Signaling:**
   ```javascript
   // Client → Server
   { type: "p2p-signal", data: { type: "offer", sdp: "..." } }

   // Server → Client
   { type: "p2p-signal", data: { type: "answer", sdp: "..." } }
   ```

2. **ICE Candidates Exchanged:**
   - Both peers exchange network candidates
   - STUN servers used for NAT traversal (not required for localhost/LAN)

3. **DataChannel Established:**
   - Direct peer-to-peer connection
   - Terminal data flows through DataChannel
   - WebSocket remains open for control messages

**Fallback:**
- If P2P fails (firewall, NAT), falls back to WebSocket
- Transparent to the user

**Performance:**
- Localhost P2P: ~1ms latency
- LAN P2P: ~5-10ms latency
- Internet P2P: Varies (depends on network path)
- WebSocket fallback: +20-50ms overhead

---

### 4. SSH Access

**Port:** `2222`

**Authentication:**
- **Password:** `SSH_PASSWORD` env var or `SETUP_TOKEN` env var
- **Username:** Maps to terminal session name (e.g., `ssh default@localhost -p 2222`)

**Connection Flow:**

1. **SSH Client Connect:**
   ```bash
   ssh default@192.168.1.50 -p 2222
   ```

2. **Password Prompt:**
   ```
   Password: <SSH_PASSWORD or SETUP_TOKEN>
   ```

3. **PTY Session Created:**
   - New PTY session created via daemon
   - Bidirectional I/O over SSH
   - Session persists until SSH disconnect

**Use Cases:**
- Terminal emulators (iTerm2, Windows Terminal)
- SSH tunneling (port forwarding)
- Scripting and automation
- Mobile SSH clients (Termius, Blink)

**Security:**
- Password compared via `timingSafeEqual` (constant-time comparison)
- Host key persisted to `~/.katulong/ssh/`
- SSH port should be firewalled on untrusted networks
- No public key authentication (password only)

**Environment Filtering:**
- Sensitive env vars (`SSH_PASSWORD`, `SETUP_TOKEN`, `KATULONG_NO_AUTH`) are filtered from PTY environments
- Prevents accidental exposure in shell sessions

---

## Session Management

### Session Lifecycle

1. **Creation:**
   - Generated during registration or login
   - 30-day expiry (2,592,000,000ms)
   - Random 32-character hex token
   - Stored server-side in `auth-state.json`

2. **Storage:**
   - Client: `katulong_session` cookie (HttpOnly, SameSite=Lax, Secure for HTTPS)
   - Server: JSON file with session metadata:
     ```json
     {
       "sessions": {
         "abc123...": {
           "expiry": 1739234567890,
           "credentialId": "xyz789..."
         }
       }
     }
     ```

3. **Validation:**
   - Checked on every HTTP request to protected endpoints
   - Checked on WebSocket upgrade
   - **Checked on every WebSocket message**
   - Validated against:
     - Expiry time (must be in future)
     - Credential exists (must not be revoked)

4. **Expiration:**
   - Expired sessions removed during validation
   - Client receives 401 Unauthorized
   - Must re-authenticate (passkey or pairing)

5. **Revocation:**
   - **Delete Credential** → All sessions for that credential invalidated
   - **Delete Device (LAN)** → Credential revoked → Sessions invalidated → WebSockets closed
   - **Revoke Setup Token** → Token invalidated (doesn't affect existing credentials)

### Session Security

**Protection Mechanisms:**

1. **Credential Whitelist:**
   - Sessions reference a `credentialId`
   - Session is invalid if credential no longer exists
   - Prevents zombie sessions after credential deletion

2. **Immediate Revocation:**
   - Deleting a credential calls `closeWebSocketsForCredential(credentialId)`
   - All active WebSockets for that credential are closed with code 1008
   - P2P connections destroyed
   - Sessions invalidated in state file

3. **Continuous Validation:**
   - WebSocket message handler re-validates session on **every message**
   - If credential revoked mid-session → connection immediately closed
   - No grace period or delayed disconnection

4. **State Locking:**
   - All state mutations use `withStateLock()` mutex
   - Prevents race conditions (concurrent credential deletion + session creation)
   - Atomic file writes (temp file + rename)

---

## Security Model

### Defense in Depth

Katulong implements multiple security layers:

#### 1. Network-Level Security

**Localhost:**
- Socket address + Host header validation
- Origin header validation (if present)
- Blocks proxy bypass (ngrok tunneling localhost traffic)

**LAN:**
- TLS encryption (self-signed certificates)
- Origin validation on WebSocket upgrade
- Private IP / mDNS domain detection

**Internet:**
- TLS encryption (provided by tunnel or reverse proxy)
- Origin validation
- Setup token prevents unauthorized registration

#### 2. Authentication Security

**WebAuthn (Passkeys):**
- FIDO2 compliant (phishing-resistant)
- Biometric authentication (Touch ID, Face ID, Windows Hello)
- Public key cryptography (private key never leaves device)
- Replay attack prevention (challenge-response)

**Pairing (LAN):**
- QR code + 8-digit PIN (two-factor)
- 30-second expiry (limited attack window)
- Single-use codes (prevents replay)
- Requires physical proximity (same network)

**Setup Tokens (Internet):**
- Single-use tokens (revoked after registration)
- Named tokens (audit trail)
- Manual generation (prevents automated attacks)

#### 3. Session Security

**Cookies:**
- `HttpOnly` (prevents XSS access)
- `SameSite=Lax` (prevents CSRF)
- `Secure` flag for HTTPS
- 30-day expiry

**Server-Side Storage:**
- Sessions stored in JSON file (not in cookies)
- Credential whitelist validation
- Immediate revocation on credential delete

#### 4. WebSocket Security

**Origin Validation:**
- Required for LAN/Internet access
- Must match Host header
- Prevents Cross-Site WebSocket Hijacking (CSWSH)

**Continuous Validation:**
- Session re-validated on every message
- Credential existence checked
- Connection closed immediately on revocation

**Close Codes:**
- `1008 (Policy Violation)` - Credential revoked
- `1000 (Normal Closure)` - Clean disconnect

#### 5. Input Validation

**Message Validation:**
- All WebSocket messages validated against schemas
- Type checking (string, number, object)
- Range validation (PTY dimensions, etc.)
- Rejects malformed messages

**Path Traversal Prevention:**
- Static file serving validates `filePath.startsWith(publicDir)`
- `isPublicPath()` rejects paths with `..`, `//`, or leading dots

**Request Body Limits:**
- 1MB limit on all public auth endpoints
- Prevents DoS attacks

#### 6. Supply Chain Security

**Self-Hosted Dependencies:**
- All frontend dependencies in `public/vendor/`
- No CDN JavaScript loaded at runtime
- Eliminates CDN trust requirements

**Dependency Auditing:**
- Pre-push hooks run full test suite
- E2E tests validate authentication flows

---

## Troubleshooting

### Issue: "Your connection is not private" (LAN HTTPS)

**Cause:** Self-signed TLS certificate not trusted by browser.

**Solutions:**

1. **Click "Advanced" → "Proceed"** (quick, per-session)
2. **Trust CA Certificate** (permanent, recommended):
   - Access `http://192.168.1.50:3001/connect/trust`
   - Download `katulong-ca.crt`
   - Install in system keychain:
     - **macOS:** Double-click → "Always Trust"
     - **Windows:** Right-click → "Install Certificate" → "Trusted Root Certification Authorities"
     - **Linux:** Copy to `/usr/local/share/ca-certificates/` → `sudo update-ca-certificates`

---

### Issue: LAN pairing shows passkey flow instead of QR code

**Cause:** Browser cached old JavaScript before access method detection was implemented.

**Solution:**
- Hard refresh: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+F5` (Windows/Linux)
- Clear browser cache
- Check console for errors

**Verification:**
```bash
curl -k https://192.168.1.50:3002/auth/status
# Should return: {"setup": true, "accessMethod": "lan"}
```

---

### Issue: WebSocket connection rejected

**Common Causes:**

1. **Missing Session Cookie:**
   - Verify `katulong_session` cookie exists in DevTools → Application → Cookies
   - Re-authenticate if expired

2. **Origin Mismatch:**
   - Check Origin header in DevTools → Network → WebSocket request
   - Origin must match Host header (e.g., both `katulong.local:3002`)

3. **Credential Revoked:**
   - Check if device was removed from Settings → LAN or Remote
   - Re-pair or re-register passkey

**Debug Logs:**
```bash
# Server logs show rejection reason
tail -f /tmp/server.log | grep WebSocket
# Example: "WebSocket rejected: not authenticated"
```

---

### Issue: P2P DataChannel not connecting

**Cause:** Firewall blocking WebRTC traffic or STUN server unreachable.

**Fallback:** Katulong automatically falls back to WebSocket if P2P fails.

**Verify:**
- DevTools → Console: Look for "P2P DataChannel connected" or "Using WebSocket fallback"
- Terminal still works (just higher latency via WebSocket)

**Performance:**
- WebSocket fallback adds ~20-50ms latency
- Still fully functional for terminal use

---

### Issue: "Setup token required" but I'm on localhost

**Cause:** Access method detected as "internet" instead of "localhost".

**Common Scenarios:**

1. **Reverse Proxy / Tunnel:**
   ```
   Socket: 127.0.0.1
   Host: your-app.ngrok.app
   → Detected as "internet" (Host header doesn't match localhost)
   ```
   **Solution:** Access directly via `http://localhost:3001`

2. **Docker / VM:**
   - Container may expose ports, but Host header is still `localhost`
   - Verify with `curl localhost:3001/auth/status`

**Verification:**
```bash
curl http://localhost:3001/auth/status
# Should return: {"setup": false} or {"setup": true, "accessMethod": "localhost"}
```

---

### Issue: Session expired immediately after login

**Causes:**

1. **System Clock Skew:**
   - Server and client clocks out of sync
   - Session expiry calculated based on server time

2. **Cookie Scope:**
   - Cookie domain doesn't match request domain
   - Check DevTools → Application → Cookies

**Solution:**
- Verify system time: `date`
- Check cookie domain matches URL
- Clear cookies and re-authenticate

---

### Issue: Cannot pair device on LAN (PIN rejected)

**Common Mistakes:**

1. **PIN Expired (30 seconds):**
   - Generate new pairing code
   - Enter PIN quickly

2. **Wrong PIN:**
   - Double-check 8-digit PIN on authenticated device

3. **Code Already Used:**
   - Pairing codes are single-use
   - Generate new code

**Debug:**
- Server logs show pairing attempts: `tail -f /tmp/server.log | grep pair`
- Example: "Pairing failed: invalid PIN"

---

### Issue: SSH connection refused

**Causes:**

1. **SSH Server Not Running:**
   ```bash
   # Verify SSH server started
   tail -f /tmp/server.log | grep SSH
   # Should see: "Katulong SSH started on port 2222"
   ```

2. **Firewall Blocking Port 2222:**
   ```bash
   # Test connectivity
   nc -zv localhost 2222
   ```

3. **Wrong Password:**
   - SSH password is `SSH_PASSWORD` env var or `SETUP_TOKEN` env var
   - Check `tail -f /tmp/server.log | grep "SSH password"`

**Solution:**
```bash
# Set SSH password explicitly
export SSH_PASSWORD="your-secure-password"
node server.js

# Connect
ssh default@localhost -p 2222
```

---

## Advanced Scenarios

### Using Katulong Behind ngrok

**Setup:**
```bash
# Terminal 1: Start Katulong
node server.js

# Terminal 2: Start ngrok
ngrok http 3002
```

**Access:**
- ngrok URL: `https://abc123.ngrok.app` → **Internet access method** (setup token + passkey)
- localhost URL: `http://localhost:3001` → **Localhost access method** (auto-authenticated)

**Generate Setup Token:**
1. Access `http://localhost:3001` (auto-authenticated)
2. Settings → Remote → "Generate New Token"
3. Copy token
4. Access `https://abc123.ngrok.app`
5. Register passkey with token

---

### Using Katulong with Cloudflare Tunnel

**Setup:**
```bash
# Install Cloudflare Tunnel
cloudflared tunnel create katulong

# Configure tunnel (config.yml)
tunnel: <tunnel-id>
credentials-file: /path/to/credentials.json
ingress:
  - hostname: katulong.example.com
    service: https://localhost:3002
    originRequest:
      noTLSVerify: true  # Accept self-signed cert
  - service: http_status:404

# Start tunnel
cloudflared tunnel run katulong
```

**Access:**
- Tunnel URL: `https://katulong.example.com` → **Internet access method**
- Same flow as ngrok (setup token + passkey)

---

### Multi-Device Setup Workflow

**Goal:** Access Katulong from laptop, phone, and tablet.

**Recommended Workflow:**

1. **Laptop (First Device - LAN):**
   ```
   https://katulong.local:3002
   → Trust certificate
   → Register passkey (Touch ID)
   → Authenticated
   ```

2. **Phone (LAN Pairing):**
   - On laptop: Settings → LAN → "Pair Device on LAN"
   - On phone: Scan QR code
   - Enter 8-digit PIN
   - Register passkey (Face ID)

3. **Tablet (Internet Access):**
   - On laptop: Settings → Remote → "Generate New Token"
   - Copy token
   - On tablet: Access `https://your-app.ngrok.app`
   - Register passkey with token

**Result:**
- All devices authenticated
- Each has own passkey
- Revoke any device individually from Settings

---

## Summary

Katulong provides three distinct access methods, each optimized for its network environment:

- **Localhost:** Auto-authenticated, direct access, no security overhead
- **LAN:** QR + PIN pairing, WebAuthn passkeys, self-signed TLS
- **Internet:** Setup tokens, WebAuthn passkeys, secure remote access

All access methods share the same security model:
- Session tokens (30-day expiry)
- Credential whitelisting (immediate revocation)
- Continuous session validation (every WebSocket message)
- Defense in depth (network, authentication, session, input validation)

Choose the access method that matches your network environment, and Katulong will automatically present the appropriate authentication flow.
