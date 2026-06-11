# Access Guide

Complete guide to accessing and authenticating with Katulong.

## Overview

Katulong provides **secure remote terminal access** to your machine. The server binds to localhost only; remote access goes through an external HTTPS tunnel (ngrok, Cloudflare Tunnel, etc.). The system detects how you're connecting and presents the appropriate authentication flow.

**Core Principle:** Localhost is trusted, everything else requires passkeys.

## Two Access Methods

| Access Method | Detection Criteria | Authentication Flow | Use Case |
|---|---|---|---|
| **Localhost** | `127.0.0.1`, `::1`, `localhost` with matching Host header | Auto-authenticated (no login required) | Local development, direct access |
| **Internet** | Everything else (tunnel domains, any non-localhost Host) | Setup token + WebAuthn passkey, or device approval | Remote access over the internet |

### Access Method Detection Logic

**Localhost Detection** (`isLocalRequest`):

- Socket address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`)
- **AND** Host header matches localhost patterns (`localhost`, `127.0.0.1`, etc.)
- **AND** Origin header (if present) matches Host header
- **Security:** Blocks proxy bypass — tunnel traffic also arrives on a loopback socket, so the socket address alone is never sufficient

**Internet Detection:**

- Everything else (tunnel domains, public hostnames)

## Initial Setup

When you first launch Katulong, **no authentication is configured**. The initial setup flow differs based on how you access it:

### 1. Localhost Initial Setup

**URL:** `http://localhost:3001`

1. Auto-authenticated (no login required)
2. Access terminal immediately
3. Optional: Generate setup tokens for registering other devices

**Why auto-authenticated?** If an attacker has localhost access, they already have full system access. No additional security layer helps.

### 2. Internet Initial Setup

**URL:** `https://katulong.example.com` (your tunnel hostname)

1. First device must use a **setup token**:
    - Generate token from localhost access
    - Settings > Remote > "Generate New Token"
    - Copy the token (shown only once)
2. Enter setup token on the login page
3. Register passkey (Touch ID / Face ID / security key)
4. Subsequent devices either use new setup tokens, or request **device approval** from the login page — an already-authenticated device sees the request and approves it by matching a 6-digit code

**Why setup tokens?** Prevents unauthorized registration when Katulong is exposed through a tunnel.

## Further Reading

- [Localhost Access](localhost.md)
- [Internet Access](internet.md)
- [Troubleshooting](troubleshooting.md)
