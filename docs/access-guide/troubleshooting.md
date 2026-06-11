# Troubleshooting

## WebSocket connection rejected

**Common Causes:**

1. **Missing Session Cookie:**
    - Verify `katulong_session` cookie exists in DevTools > Application > Cookies
    - Re-authenticate if expired

2. **Origin Mismatch:**
    - Check Origin header in DevTools > Network > WebSocket request
    - Origin must match Host header (e.g., both `katulong.example.com`)

3. **Credential Revoked:**
    - Check if device was removed from Settings > Remote
    - Re-register the passkey

**Debug Logs:**

```bash
# Server logs show rejection reason
tail -f /tmp/server.log | grep WebSocket
# Example: "WebSocket rejected: not authenticated"
```

## P2P DataChannel not connecting

**Cause:** Firewall blocking WebRTC traffic, STUN server unreachable, or the optional `node-datachannel` package is not installed.

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

## Device approval request never appears

**Common Causes:**

1. **No authenticated device online:** The approval prompt is delivered over the WebSocket to already-authenticated devices — at least one must have Katulong open
2. **Request expired:** Device-auth requests expire after 5 minutes; start a new request
3. **Different instance:** Make sure both devices are talking to the same tunnel hostname
