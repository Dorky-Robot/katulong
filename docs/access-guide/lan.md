# LAN Access

**URLs:**

- HTTPS: `https://192.168.1.50:3002` (example IP)
- HTTPS: `https://katulong.local:3002` (mDNS)
- HTTP: `http://192.168.1.50:3001` (limited — only for `/connect/trust` and public endpoints)

## Authentication: QR Code + 8-Digit PIN Pairing

### Pairing Flow (Subsequent Devices)

1. **Generate Pairing Code** (on authenticated device):
    - Open Settings > LAN tab
    - Click "Pair Device on LAN"
    - QR code and 8-digit PIN appear
    - Code is valid for **30 seconds**

2. **Scan QR Code** (on new device):
    - Open camera app and scan QR code
    - **OR** manually navigate to `https://192.168.1.50:3002/pair?code=<UUID>`

3. **Enter PIN:**
    - Enter the 8-digit PIN shown on the authenticated device
    - Click "Confirm"

4. **Device Paired:**
    - Session token stored in browser cookie
    - WebAuthn passkey registered (for this device)
    - Access granted to terminal

### Why QR + PIN for LAN?

- **QR Code:** Transmits the pairing UUID securely (no typing long UUIDs)
- **8-Digit PIN:** Prevents unauthorized pairing even if someone sees the QR code
- **30-Second Expiry:** Limits attack window
- **Single-Use:** Each code can only be used once

## mDNS Discovery

Katulong advertises as `katulong.local` via mDNS/Bonjour. Accessible via `https://katulong.local:3002` on the local network.

Requires Avahi (Linux), Bonjour (macOS), or Bonjour Print Services (Windows).

## TLS Certificates

- Self-signed certificate auto-generated on first run
- Stored in `~/.katulong/tls/`
- Browser will warn about "not private" — this is expected
- Trust the certificate in system keychain for seamless access:
    1. Access `http://192.168.1.50:3001/connect/trust`
    2. Download `katulong-ca.crt`
    3. Install in system keychain (instructions provided on page)

## Session Cookies

- `katulong_session` cookie stores 30-day session token
- `HttpOnly` flag prevents JavaScript access
- `SameSite=Lax` prevents CSRF attacks
- Secure flag set for HTTPS
