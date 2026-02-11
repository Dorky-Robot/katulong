# Authentication & Pairing Design Specification

**Version**: 2.0
**Status**: Design Document
**Last Updated**: 2026-02-10

---

## Executive Summary

Katulong provides **direct terminal access to the host machine** over HTTP/HTTPS. Every authentication decision is a security-critical operation. This document defines the complete authentication and device pairing architecture, combining product requirements, user experience, and security constraints.

---

## 1. Product Vision & Motivation

### 1.1 Core Problem

Users need to access their terminal from multiple devices (laptop, phone, tablet) with these constraints:

1. **Security**: Terminal access must be strongly authenticated
2. **Convenience**: Setup should be frictionless on primary device, secure on additional devices
3. **Zero-configuration**: Should work on LAN without external dependencies
4. **Internet-accessible**: Should support reverse proxies (ngrok, Cloudflare Tunnel) for remote access
5. **Platform-agnostic**: Should work across browsers and operating systems

### 1.2 Design Principles

1. **Defense in Depth**: Multiple layers of security (WebAuthn + TLS + session management)
2. **Fail Secure**: Default to denying access when in doubt
3. **Explicit Trust**: Certificate trust and device pairing require explicit user action
4. **Minimal Attack Surface**: Public endpoints are strictly controlled and rate-limited
5. **Auditability**: All authentication events are logged

---

## 2. Access Scenarios & User Flows

### 2.1 Initial Setup (First Device)

**Context**: First time running Katulong, no credentials registered.

**Flow**:
1. User starts Katulong server → receives `SETUP_TOKEN` in console
2. User accesses `http://localhost:3001` in browser
3. System auto-authenticates (localhost bypass) and shows main UI
4. User goes to Settings → "Register Passkey"
5. User enters `SETUP_TOKEN` and clicks "Register Passkey"
6. **Browser shows platform authenticator prompt** (Touch ID, Windows Hello, fingerprint)
7. User authenticates → passkey registered, session created
8. User can now access terminal

**Expected Behavior**:
- ✅ No QR code or cross-platform authenticator prompts
- ✅ Uses built-in biometrics (fastest, most convenient)
- ✅ Localhost access bypasses auth until passkey is registered

---

### 2.2 LAN Access (Same Network)

**Context**: Accessing Katulong from another device on the same local network (192.168.x.x, katulong.local).

#### 2.2.1 Initial LAN Access (HTTPS Certificate Trust)

**Flow**:
1. User accesses `https://katulong.local:3002` or `https://192.168.1.x:3002`
2. Browser shows "Your connection is not private" (self-signed cert)
3. User must manually trust certificate OR use cert installation flow:
   - Visit `http://katulong.local:3001/connect/trust` (HTTP allowed for this path only)
   - Download CA certificate or mobile config
   - Install on device
4. After trusting cert, HTTPS works

**Security Rationale**:
- Self-signed certs are necessary for LAN HTTPS without external CA
- Explicit trust action prevents MITM attacks
- HTTP access is restricted to cert installation path only

#### 2.2.2 LAN Device Pairing (QR + PIN)

**Flow** (from primary device):
1. User (on authenticated laptop) goes to Settings → "Pair Device"
2. System generates pairing challenge (UUID + 6-digit PIN)
3. QR code displayed containing: `{"code": "uuid", "pin": "123456", "host": "katulong.local:3002"}`
4. QR code expires in 30 seconds (single-use)

**Flow** (from secondary device):
1. User visits `https://katulong.local:3002` (after trusting cert)
2. Since not authenticated, redirected to `/login`
3. Login page shows option to "Pair with QR Code" (for LAN access)
4. User scans QR code from primary device
5. User enters 6-digit PIN (rate-limited: 10 attempts per 30 seconds)
6. If valid: WebAuthn registration is triggered
7. **Browser shows platform authenticator prompt** (Touch ID, etc.)
8. User authenticates → passkey registered for this device, session created

**Expected Behavior**:
- ✅ QR + PIN provides human-verified device proximity (same room)
- ✅ After pairing, device has its own passkey (independent authentication)
- ✅ No long-lived shared secrets
- ✅ PIN is short-lived (30s), single-use, rate-limited

---

### 2.3 Internet Access (Ngrok/Reverse Proxy)

**Context**: Accessing Katulong through reverse proxy (ngrok, Cloudflare Tunnel) from anywhere on internet.

#### 2.3.1 Ngrok Access Flow

**Setup**:
```bash
ngrok http 3001
# Gives: https://felix-katulong.ngrok.app
```

**Flow**:
1. User visits `https://felix-katulong.ngrok.app/login`
2. System detects ngrok domain (not LAN, not localhost)
3. Shows passkey login page (no QR pairing option shown for internet access)
4. **First-time setup**: User clicks "Register New Passkey"
5. User enters `SETUP_TOKEN` from console
6. **Browser shows platform authenticator prompt** (Touch ID, etc.)
7. User authenticates → passkey registered, session created

**Expected Behavior**:
- ✅ No cert trust flow (ngrok provides valid TLS)
- ✅ No QR pairing (internet access = not physically co-located)
- ✅ Uses SETUP_TOKEN for first device
- ✅ Additional devices use QR pairing on LAN OR get their own SETUP_TOKEN

**Security Rationale**:
- QR + PIN assumes physical proximity (same room)
- Internet access has no proximity guarantee → requires SETUP_TOKEN
- Ngrok domain detected via Host header (not localhost, not IP, not .local)

---

### 2.4 Subsequent Access (Returning User)

**Context**: User has already registered passkey on this device.

**Flow**:
1. User visits Katulong (any URL: localhost, LAN, ngrok)
2. If authenticated (valid session cookie): shows main UI
3. If not authenticated: redirected to `/login`
4. User clicks "Login with Passkey"
5. **Browser shows passkey selection dialog** (lists registered passkeys)
6. User selects passkey → authenticates → session created

**Expected Behavior**:
- ✅ No QR codes, no setup tokens, no PIN
- ✅ One-click login with biometrics
- ✅ Session persists for 30 days (sliding expiry)

---

## 3. Technical Architecture

### 3.1 Authentication Stack

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Transport Security (TLS)                   │
│ - HTTPS for LAN (self-signed) and internet (ngrok)  │
│ - HTTP only for: localhost, /connect/trust          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Layer 2: Request Classification                     │
│ - isLocalRequest(req) → auto-authenticate           │
│ - isPublicPath(pathname) → skip auth                │
│ - Else → require authentication                     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Layer 3: WebAuthn (Passkeys)                        │
│ - Registration: /auth/register/options + verify     │
│ - Authentication: /auth/login/options + verify      │
│ - Pairing: /auth/pair/start + verify                │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Layer 4: Session Management                         │
│ - HttpOnly, Secure cookies                          │
│ - 30-day expiry, sliding window                     │
│ - CSRF protection for state changes                 │
└─────────────────────────────────────────────────────┘
```

### 3.2 WebAuthn Configuration

**Registration Options** (`lib/auth.js`):
```javascript
{
  rpName: "Katulong",
  rpID: hostname, // e.g., "katulong.local", "felix-katulong.ngrok.app"
  userName: "owner",
  userID: Buffer<16>, // Stable across devices
  attestationType: "none",
  authenticatorSelection: {
    authenticatorAttachment: "platform", // ← CRITICAL: Forces platform authenticator
    residentKey: "preferred",
    userVerification: "preferred"
  }
}
```

**Why `authenticatorAttachment: "platform"`**:
- Forces browser to use built-in biometrics (Touch ID, Windows Hello, fingerprint)
- Prevents QR code/phone prompts that confuse users
- Platform authenticators are always available on the device being used
- More convenient than security keys or phone-based passkeys

**Authentication Options**:
```javascript
{
  rpID: hostname,
  allowCredentials: [...], // List of registered credential IDs
  userVerification: "preferred"
}
```

### 3.3 Access Control Logic

#### 3.3.1 `isLocalRequest(req)`

**Purpose**: Determine if request comes from localhost (trusted).

**Implementation**:
```javascript
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress;

  // Must be loopback socket
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") {
    return false;
  }

  // CRITICAL: Check Host/Origin headers to detect proxies
  const host = req.headers.host?.toLowerCase() || "";
  const origin = req.headers.origin?.toLowerCase() || "";

  const hostIsLocal = host === "localhost" ||
                      host.startsWith("localhost:") ||
                      host === "127.0.0.1" ||
                      host.startsWith("127.0.0.1:");

  const originIsLocal = !origin ||
                        origin.includes("://localhost") ||
                        origin.includes("://127.0.0.1");

  // Both must be local to prevent ngrok bypass
  return hostIsLocal && originIsLocal;
}
```

**Security Rationale**:
- Ngrok/tunnels connect via loopback but have non-localhost Host headers
- Checking BOTH socket AND headers prevents proxy bypass
- See: SECURITY_IMPROVEMENTS.md #32 (proxy bypass fix)

#### 3.3.2 `isPublicPath(pathname)`

**Purpose**: Determine if path can be accessed without authentication.

**Implementation**:
```javascript
const STATIC_EXTS = new Set([".js", ".css", ".png", ".ico", ".webp", ".svg", ".woff2", ".json"]);

const PUBLIC_AUTH_ROUTES = new Set([
  "/auth/status",
  "/auth/register/options",
  "/auth/register/verify",
  "/auth/login/options",
  "/auth/login/verify",
  "/auth/logout",
  "/auth/pair/verify",
]);

function isPublicPath(pathname) {
  // Explicit HTML pages
  if (pathname === "/login" || pathname === "/login.html") return true;
  if (pathname === "/pair" || pathname === "/pair.html") return true;
  if (pathname.startsWith("/connect/trust")) return true;

  // Auth endpoints
  if (PUBLIC_AUTH_ROUTES.has(pathname)) return true;

  // Static assets (with strict validation)
  const ext = extname(pathname);
  if (ext && STATIC_EXTS.has(ext) && pathname !== "/") {
    // Reject path traversal
    if (pathname.includes("..") || pathname.includes("//") || pathname.startsWith("/.")) {
      return false;
    }
    return true;
  }

  return false;
}
```

**Security Rationale**:
- Explicit allowlist prevents auth bypass
- Static assets allowed to load login page
- Path traversal blocked (see: SECURITY_IMPROVEMENTS.md #3)

### 3.4 HTTPS Enforcement

**Goal**: Force HTTPS except for localhost and cert installation.

**Implementation** (`server.js` line 842-874):
```javascript
if (!req.socket.encrypted && !isLocalRequest(req)) {
  if (!HTTP_ALLOWED_PATHS.includes(pathname) && !isPublicPath(pathname)) {
    // Redirect to HTTPS or login page
  }
}
```

**HTTP_ALLOWED_PATHS**:
```javascript
[
  "/connect/trust",
  "/connect/trust/ca.crt",
  "/connect/trust/ca.mobileconfig"
]
```

**Security Rationale**:
- Only trust actual TLS socket state, not `X-Forwarded-Proto` header
- Cert installation requires HTTP access (chicken-and-egg problem)
- Public paths (login assets) allowed on HTTP for ngrok compatibility
- See: SECURITY_IMPROVEMENTS.md #2 (header trust removal)

---

## 4. Security Properties

### 4.1 Authentication Guarantees

| Scenario | Authentication Method | Session Lifetime | Additional Security |
|----------|----------------------|------------------|-------------------|
| Localhost | Auto (loopback + host check) | N/A (per-request) | Proxy bypass protection |
| LAN (first device) | SETUP_TOKEN + WebAuthn | 30 days | Self-signed cert trust required |
| LAN (additional) | QR + PIN + WebAuthn | 30 days | 30s expiry, single-use, rate-limited |
| Internet (ngrok) | SETUP_TOKEN + WebAuthn | 30 days | Valid TLS from ngrok |
| Returning user | WebAuthn passkey | 30 days (sliding) | CSRF protection |

### 4.2 Threat Mitigations

| Threat | Mitigation | Reference |
|--------|------------|-----------|
| **Auth bypass via proxy** | Check both socket AND headers in `isLocalRequest()` | SECURITY_IMPROVEMENTS.md #32 |
| **MITM on LAN** | Require explicit cert trust | Built-in |
| **Credential stuffing** | WebAuthn (phishing-resistant) | Built-in |
| **Session hijacking** | HttpOnly + Secure + SameSite cookies | Built-in |
| **Replay attacks** | Challenge-response (WebAuthn) | Built-in |
| **Pairing brute-force** | Rate limiting (10/30s) + 30s expiry | SECURITY_IMPROVEMENTS.md #8 |
| **DoS on auth endpoints** | 1MB body limit + rate limiting | SECURITY_IMPROVEMENTS.md #1 |
| **Session race conditions** | Mutex lock (`withStateLock`) | SECURITY_IMPROVEMENTS.md #5 |
| **Credential lockout** | 5 failed attempts → 15min lockout | SECURITY_IMPROVEMENTS.md #9 |
| **Protocol downgrade** | Never trust X-Forwarded-Proto | SECURITY_IMPROVEMENTS.md #2 |

### 4.3 Security-Critical Code Paths

**Auth bypass vulnerabilities** - Any change to:
- `isLocalRequest()` - localhost detection
- `isPublicPath()` - route access control
- `isAuthenticated()` - session validation
- HTTPS enforcement logic
- WebSocket origin validation

**See CLAUDE.md** for complete code review checklist.

---

## 5. Current Implementation Issues

### 5.1 Platform Authenticator Not Showing

**Symptom**: Browser shows QR code/security key dialog instead of Touch ID/fingerprint.

**Root Causes**:
1. ❌ **Incognito mode**: Platform authenticators disabled in private browsing
2. ❌ **Missing `authenticatorAttachment`**: Not forcing platform authenticator
3. ⚠️ **Browser compatibility**: Some browsers default to cross-platform

**Fixes Applied**:
- ✅ Added `authenticatorAttachment: "platform"` to registration options
- ⚠️ User must use regular (non-incognito) browser window

### 5.2 Static Asset MIME Type Issues

**Symptom**: `/login.js` returns HTML instead of JavaScript.

**Root Causes**:
1. ❌ **Wrong MIME type**: `text/javascript` instead of `application/javascript`
2. ⚠️ **Redirect confusion**: Possible redirect loop or auth bypass

**Fixes Applied**:
- ✅ Changed MIME type to `application/javascript`
- ⚠️ Need to verify no redirect loops for static assets

### 5.3 Ngrok + Localhost Confusion

**Symptom**: Inconsistent behavior between localhost and ngrok access.

**Root Causes**:
1. ⚠️ **Different code paths**: LAN vs internet detection heuristics
2. ⚠️ **HTTPS enforcement**: Different behavior for encrypted vs plain
3. ⚠️ **Public path handling**: isPublicPath might not work correctly for all scenarios

**Needed**:
- Clean separation of concerns (localhost / LAN / internet)
- Consistent static asset handling across all access methods
- Clear decision tree in request handler

---

## 6. Proposed Refactoring Plan

### Phase 1: Clean Request Routing (Foundation)

**Goal**: Clear, testable request classification and routing.

**Tasks**:
1. Extract access method detection:
   ```javascript
   function getAccessMethod(req) {
     if (isLocalRequest(req)) return "localhost";
     const host = req.headers.host?.split(":")[0] || "";
     if (host.endsWith(".local") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "lan";
     return "internet";
   }
   ```

2. Simplify HTTPS enforcement:
   ```javascript
   function requireHTTPS(req, pathname) {
     if (req.socket.encrypted) return false; // Already HTTPS
     if (isLocalRequest(req)) return false; // Localhost allowed
     if (pathname.startsWith("/connect/trust")) return false; // Cert install
     if (isPublicPath(pathname)) {
       // Public paths allowed on HTTP for ngrok
       const method = getAccessMethod(req);
       return method === "lan"; // LAN must use HTTPS after cert trust
     }
     return true; // Everything else requires HTTPS
   }
   ```

3. Clear static file serving:
   ```javascript
   function serveStaticFile(res, pathname) {
     const publicDir = join(__dirname, "public");
     const filePath = resolve(publicDir, pathname.slice(1));

     // Security checks
     if (!filePath.startsWith(publicDir)) return false;
     if (!existsSync(filePath)) return false;
     if (statSync(filePath).isDirectory()) return false;

     // Serve file
     const ext = extname(filePath);
     const mimeType = MIME[ext] || "application/octet-stream";
     res.writeHead(200, {
       "Content-Type": mimeType,
       "Cache-Control": "public, max-age=31536000" // 1 year for static assets
     });
     res.end(readFileSync(filePath));
     return true;
   }
   ```

4. Write tests for all scenarios:
   - Localhost access (all paths)
   - LAN HTTP access (only /connect/trust allowed)
   - LAN HTTPS access (after cert trust)
   - Internet HTTPS access (ngrok)
   - Static assets on all access methods

### Phase 2: WebAuthn Consistency

**Goal**: Platform authenticator works consistently across all flows.

**Tasks**:
1. Verify `authenticatorAttachment: "platform"` in ALL registration flows:
   - Initial setup (`/auth/register/options`)
   - Additional passkey (`generateRegistrationOptsForUser`)
   - Pairing (`/auth/pair/start`)

2. Add client-side checks:
   ```javascript
   if (!window.PublicKeyCredential) {
     showError("WebAuthn not supported. Please use HTTPS and a modern browser.");
     return;
   }

   if (window.isSecureContext === false) {
     showError("Secure context required. Please use HTTPS or localhost.");
     return;
   }
   ```

3. Handle incognito mode gracefully:
   ```javascript
   try {
     const credential = await startRegistration(options);
   } catch (err) {
     if (err.name === "NotAllowedError") {
       showError("Passkey registration was cancelled. Note: Private/Incognito mode may not support biometric authentication.");
     }
   }
   ```

### Phase 3: UI/UX Clarity

**Goal**: User always knows which auth method to use.

**Tasks**:
1. Login page shows appropriate options based on access method:
   ```javascript
   const method = detectAccessMethod(); // localhost, lan, internet

   if (method === "localhost") {
     // Show: "Access granted (localhost)"
   } else if (method === "lan" && !setup) {
     // Show: "Pair Device" button (QR flow)
   } else if (method === "internet" && !setup) {
     // Show: "Register Passkey" (SETUP_TOKEN)
   } else {
     // Show: "Login with Passkey" (existing user)
   }
   ```

2. Clear error messages:
   - "Please use a regular browser window (not incognito)" for NotAllowedError
   - "HTTPS required. Visit /connect/trust to install certificate" for LAN HTTP
   - "Setup token required for first device" for internet access

3. Visual indicators:
   - Lock icon for HTTPS
   - LAN icon for local network access
   - Globe icon for internet access

### Phase 4: Testing & Validation

**Goal**: Comprehensive test coverage for all scenarios.

**Test Matrix**:
```
Access Method × Browser State × Action
─────────────────────────────────────
Localhost × (setup/no-setup) × (navigate, static assets)
LAN HTTP × (no-cert) × (navigate, static assets) → redirect to /connect/trust
LAN HTTPS × (setup/no-setup/paired) × (login, register, static assets)
Internet × (setup/no-setup) × (login, register, static assets)
```

**Tests to Write**:
1. Unit tests for helpers:
   - `getAccessMethod(req)` with various Host headers
   - `isPublicPath(pathname)` for all allowed paths
   - `requireHTTPS(req, pathname)` for all combinations

2. Integration tests for flows:
   - Initial setup on localhost → passkey registration
   - LAN pairing → QR + PIN + passkey
   - Internet setup → SETUP_TOKEN + passkey
   - Static asset serving (login.js, login.css, etc.)

3. Security tests:
   - Proxy bypass attempts
   - Path traversal attempts
   - Rate limiting enforcement
   - Session expiry and sliding window

---

## 7. Success Criteria

### 7.1 Functional Requirements

- ✅ Localhost access works without authentication
- ✅ LAN access requires cert trust + pairing OR passkey
- ✅ Internet access requires SETUP_TOKEN + passkey
- ✅ Platform authenticator (Touch ID, etc.) used for all WebAuthn flows
- ✅ No QR codes shown when platform authenticator is available
- ✅ Static assets load correctly on all access methods
- ✅ Session persists for 30 days with sliding expiry

### 7.2 Security Requirements

- ✅ All security improvements from SECURITY_IMPROVEMENTS.md preserved
- ✅ No auth bypasses via proxy, path traversal, or header spoofing
- ✅ Rate limiting on all public endpoints
- ✅ CSRF protection on state-changing operations
- ✅ Credential lockout after 5 failed attempts
- ✅ All sessions use HttpOnly, Secure, SameSite cookies

### 7.3 User Experience Requirements

- ✅ Initial setup takes < 30 seconds
- ✅ LAN pairing takes < 60 seconds
- ✅ Returning user login takes < 5 seconds (one click + biometric)
- ✅ Clear error messages (no cryptic WebAuthn errors)
- ✅ Works on all major browsers (Chrome, Safari, Firefox, Edge)
- ✅ Works on all major platforms (Mac, Windows, Linux, iOS, Android)

### 7.4 Code Quality Requirements

- ✅ All tests passing (unit + integration)
- ✅ Test coverage ≥ 90% for auth code paths
- ✅ No console errors or warnings
- ✅ Clear separation of concerns (routing, auth, serving)
- ✅ Comprehensive inline documentation
- ✅ CLAUDE.md code review checklist satisfied

---

## 8. Implementation Notes

### 8.1 Migration Path

**Backward Compatibility**:
- Existing sessions remain valid
- Existing passkeys remain valid
- Pairing flow changes are non-breaking

**Deployment**:
1. Deploy refactored code
2. Run migration tests
3. Monitor logs for auth errors
4. Roll back if critical issues detected

### 8.2 Testing Strategy

**Pre-deployment**:
1. Run full test suite: `npm test`
2. Manual testing on all access methods:
   - Localhost (Mac)
   - LAN (iPhone, iPad)
   - Ngrok (remote laptop)
3. Verify no console errors
4. Verify platform authenticator used

**Post-deployment**:
1. Monitor auth success rates
2. Check for session loss or corruption
3. Verify no security regressions

---

## 9. References

- **SECURITY_IMPROVEMENTS.md** - Security hardening history
- **CLAUDE.md** - Code review checklist
- **WebAuthn Spec** - https://www.w3.org/TR/webauthn-2/
- **MDN WebAuthn Guide** - https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API

---

## Appendix: Decision Log

### Why platform authenticator only?

**Decision**: Force `authenticatorAttachment: "platform"` instead of allowing both platform and cross-platform.

**Rationale**:
- Katulong is self-hosted terminal access (personal use, not enterprise)
- Users setting up on their own devices always have platform authenticator available
- Platform auth is faster and more convenient than security keys or phones
- If user really needs cross-platform, they can pair via QR on LAN or use a different browser

**Trade-off**: Users who prefer security keys or phone-based passkeys can't use them directly. Acceptable for this use case.

### Why QR pairing only on LAN?

**Decision**: QR + PIN pairing only available for LAN access, not internet.

**Rationale**:
- QR + PIN assumes physical proximity (same room)
- Internet access has no proximity guarantee
- SETUP_TOKEN provides equivalent security for internet without proximity assumption

**Trade-off**: Users accessing via ngrok can't pair new devices remotely. Must have physical access to server console for SETUP_TOKEN.

### Why 6-digit PIN instead of 8 or 4?

**Decision**: 6-digit PIN (1 million combinations).

**Rationale**:
- 30-second expiry limits brute-force to ~300 attempts max (10/s rate limit)
- Rate limiting makes brute-force impractical
- 6 digits is easy to read and type (good UX)
- 8 digits would be harder to remember/type

**Trade-off**: Slightly lower entropy than 8 digits, but mitigated by rate limiting and expiry.

---

**End of Document**
