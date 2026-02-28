# Troubleshooting

## "Your connection is not private" (LAN HTTPS)

**Cause:** Self-signed TLS certificate not trusted by browser.

**Solutions:**

1. **Click "Advanced" > "Proceed"** (quick, per-session)
2. **Trust CA Certificate** (permanent, recommended):
    - Access `http://192.168.1.50:3001/connect/trust`
    - Download `katulong-ca.crt`
    - Install in system keychain:
        - **macOS:** Double-click > "Always Trust"
        - **Windows:** Right-click > "Install Certificate" > "Trusted Root Certification Authorities"
        - **Linux:** Copy to `/usr/local/share/ca-certificates/` > `sudo update-ca-certificates`

## LAN pairing shows passkey flow instead of QR code

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

## WebSocket connection rejected

**Common Causes:**

1. **Missing Session Cookie:**
    - Verify `katulong_session` cookie exists in DevTools > Application > Cookies
    - Re-authenticate if expired

2. **Origin Mismatch:**
    - Check Origin header in DevTools > Network > WebSocket request
    - Origin must match Host header (e.g., both `katulong.local:3002`)

3. **Credential Revoked:**
    - Check if device was removed from Settings > LAN or Remote
    - Re-pair or re-register passkey

**Debug Logs:**

```bash
# Server logs show rejection reason
tail -f /tmp/server.log | grep WebSocket
# Example: "WebSocket rejected: not authenticated"
```

## P2P DataChannel not connecting

**Cause:** Firewall blocking WebRTC traffic or STUN server unreachable.

**Fallback:** Katulong automatically falls back to WebSocket if P2P fails.

**Verify:**

- DevTools > Console: Look for "P2P DataChannel connected" or "Using WebSocket fallback"
- Terminal still works (just higher latency via WebSocket)
- WebSocket fallback adds ~20-50ms latency, still fully functional

## "Setup token required" but I'm on localhost

**Cause:** Access method detected as "internet" instead of "localhost".

**Common Scenarios:**

1. **Reverse Proxy / Tunnel:** Host header doesn't match localhost patterns
    - **Solution:** Access directly via `http://localhost:3001`

2. **Docker / VM:** Container may expose ports, but Host header is still `localhost`
    - Verify with `curl localhost:3001/auth/status`

**Verification:**

```bash
curl http://localhost:3001/auth/status
# Should return: {"setup": false} or {"setup": true, "accessMethod": "localhost"}
```

## Session expired immediately after login

**Causes:**

1. **System Clock Skew:** Server and client clocks out of sync
2. **Cookie Scope:** Cookie domain doesn't match request domain

**Solution:**

- Verify system time: `date`
- Check cookie domain matches URL
- Clear cookies and re-authenticate

## Cannot pair device on LAN (PIN rejected)

**Common Mistakes:**

1. **PIN Expired (30 seconds):** Generate new pairing code
2. **Wrong PIN:** Double-check 8-digit PIN on authenticated device
3. **Code Already Used:** Pairing codes are single-use, generate new code

**Debug:**

```bash
# Server logs show pairing attempts
tail -f /tmp/server.log | grep pair
# Example: "Pairing failed: invalid PIN"
```

## SSH connection refused

**Causes:**

1. **SSH Server Not Running:**
    ```bash
    tail -f /tmp/server.log | grep SSH
    # Should see: "Katulong SSH started on port 2222"
    ```

2. **Firewall Blocking Port 2222:**
    ```bash
    nc -zv localhost 2222
    ```

3. **Wrong Password:** SSH password is `SSH_PASSWORD` env var or `SETUP_TOKEN` env var

**Solution:**

```bash
# Set SSH password explicitly
export SSH_PASSWORD="your-secure-password"
node server.js

# Connect
ssh default@localhost -p 2222
```
