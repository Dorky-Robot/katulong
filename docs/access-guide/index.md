# Access Guide

Complete guide to accessing and authenticating with Katulong across different network environments.

## Overview

Katulong provides **secure remote terminal access** to your machine through multiple access methods, each optimized for different network environments. The system automatically detects how you're connecting and presents the appropriate authentication flow.

**Core Principle:** Localhost is trusted, LAN requires pairing, Internet requires passkeys.

## Three Access Methods

Katulong recognizes three distinct access methods based on how you connect:

| Access Method | Detection Criteria | Authentication Flow | Use Case |
|---|---|---|---|
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

## Initial Setup

When you first launch Katulong, **no authentication is configured**. The initial setup flow differs based on how you access it:

### 1. Localhost Initial Setup

**URL:** `http://localhost:3001` or `https://localhost:3002`

1. Auto-authenticated (no login required)
2. Access terminal immediately
3. Optional: Generate setup tokens for pairing other devices

**Why auto-authenticated?** If an attacker has localhost access, they already have full system access. No additional security layer helps.

### 2. LAN Initial Setup

**URL:** `https://192.168.x.x:3002` or `https://katulong.local:3002`

1. Browser shows "Your connection is not private" (self-signed certificate)
2. Click "Advanced" > "Proceed to 192.168.x.x (unsafe)" to trust the certificate
3. First device must register via WebAuthn passkey:
    - Click "Register with Passkey"
    - Use Touch ID / Face ID / fingerprint
    - Device is now paired
4. Subsequent devices use QR + PIN pairing (see [LAN Access](lan.md))

**Why HTTPS for LAN?** WebAuthn (passkeys) requires HTTPS. Katulong auto-generates self-signed certificates for LAN use.

### 3. Internet Initial Setup

**URL:** `https://your-tunnel.ngrok.app` or public IP

1. First device must use a **setup token**:
    - Generate token from localhost or LAN access
    - Settings > Remote > "Generate New Token"
    - Copy the token (shown only once)
2. Enter setup token on the login page
3. Register passkey (Touch ID / Face ID / security key)
4. Subsequent devices use new setup tokens (generated from authenticated session)

**Why setup tokens?** Prevents unauthorized registration when Katulong is exposed to the internet.
