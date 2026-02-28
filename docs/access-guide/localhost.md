# Localhost Access

**URLs:**

- HTTP: `http://localhost:3001` or `http://127.0.0.1:3001`
- HTTPS: `https://localhost:3002` or `https://127.0.0.1:3002`

## Authentication

**None required** — auto-authenticated. No login page, no passkey, no pairing. Direct access to terminal and settings.

## Security

- Trusts socket address + Host header validation
- Rejects if Host header doesn't match (prevents proxy bypass)
- Rejects if Origin header mismatches (prevents tunnel bypass)

### Blocked Scenarios

```javascript
// Blocked: ngrok tunnel to localhost (proxy bypass attempt)
Socket: 127.0.0.1
Host: your-app.ngrok.app
// Rejected (Host header doesn't match localhost patterns)

// Blocked: Mismatched origin
Socket: 127.0.0.1
Host: localhost
Origin: https://evil.com
// Rejected (Origin doesn't match Host)
```

## Typical Workflow

1. Launch Katulong: `katulong start`
2. Open browser: `http://localhost:3001`
3. Terminal loads immediately
4. Generate setup tokens or pair LAN devices from Settings
