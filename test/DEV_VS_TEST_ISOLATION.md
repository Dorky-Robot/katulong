# Dev vs Test Environment Isolation

## The Problem We Solved

Previously, running E2E tests would kill your dev server because cleanup commands were too broad:
```bash
pkill -f "node.*server.js"  # ❌ KILLS BOTH DEV AND TEST!
```

## Complete Isolation

Dev and test environments are now **completely separate**:

### Dev Environment
- **Ports:** 3001 (HTTP), 3002 (HTTPS), 2222 (SSH)
- **Socket:** `/tmp/katulong-daemon.sock`
- **Data:** `~/.katulong/` or `$KATULONG_DATA_DIR`
- **Process:** Long-running, started manually
- **Auth:** Real WebAuthn/passkeys

### Test Environment  
- **Port:** 3099
- **Socket:** `/tmp/katulong-test.sock`
- **Data:** `/tmp/katulong-e2e-data`
- **Process:** Started/stopped by Playwright
- **Auth:** `KATULONG_NO_AUTH=1` (bypassed for testing)

## Safe Test Commands

### ✅ Safe (Only affects test processes):
```bash
# Clean up test processes only
npm run test:e2e:clean

# Or manually:
bash test/e2e/cleanup-test-server.sh

# Or very specifically:
lsof -ti:3099 | xargs kill -9  # Only test port
rm -f /tmp/katulong-test.sock  # Only test socket
```

### ❌ DANGEROUS (Kills dev processes too!):
```bash
pkill -f "node.*server.js"     # Kills BOTH!
pkill -f "node entrypoint.js"  # Kills BOTH!
pkill -f katulong              # Kills EVERYTHING!
pkill node                     # Kills ALL node processes!
```

## Running Tests Safely

### Method 1: Let Playwright handle it (recommended)
```bash
# Playwright automatically starts/stops test server
npm run test:e2e

# Your dev server keeps running on port 3001/3002 ✓
```

### Method 2: Manual control
```bash
# Clean test environment first
npm run test:e2e:clean

# Run tests with fresh server
CI=1 npm run test:e2e -- credential-revoke-security --workers=1

# Dev server still running ✓
```

### Method 3: Specific test file
```bash
npm run test:e2e -- tokens.e2e.js

# Dev server unaffected ✓
```

## Verifying Dev Server Still Running

After running tests, check your dev server:
```bash
# Should show processes on ports 3001/3002
lsof -ti:3001,3002

# Should show daemon socket
ls -la /tmp/katulong-daemon.sock

# Or just visit in browser:
open http://localhost:3001
```

## Process Identification

### How to identify which process is which:

```bash
# Show all Katulong processes
ps aux | grep katulong

# Dev processes will show:
#   node entrypoint.js (no PORT env var, or PORT=3001)
#   Socket: /tmp/katulong-daemon.sock

# Test processes will show:
#   PORT=3099
#   KATULONG_SOCK=/tmp/katulong-test.sock
#   KATULONG_DATA_DIR=/tmp/katulong-e2e-data
```

## Why Playwright Doesn't Kill Dev

Playwright's `webServer` config uses:
```javascript
{
  command: "bash test/e2e/start-test-server.sh",
  port: 3099,  // Different from dev!
  reuseExistingServer: !process.env.CI
}
```

When the test completes, Playwright:
1. Only kills processes it started (on port 3099)
2. Doesn't touch other ports (3001/3002 = safe)
3. Only removes test socket (not dev socket)

## Hot Reload in Dev

While tests run, your dev environment:
- ✅ Keeps running on port 3001/3002
- ✅ Can still reload code changes
- ✅ Completely independent
- ✅ No interference from tests

## Troubleshooting

### "Dev server died after running tests"
**Cause:** Someone used a broad `pkill` command

**Fix:**
```bash
# Restart dev services (safe script coming soon)
node daemon.js > /tmp/katulong-daemon.log 2>&1 &
node server.js > /tmp/katulong-server.log 2>&1 &
```

### "Tests fail with port already in use"
**Cause:** Previous test didn't clean up

**Fix:**
```bash
npm run test:e2e:clean
```

### "Can't tell which process is which"
```bash
# Show full command line
ps aux | grep -E "(3001|3002|3099)" 

# Dev will be on 3001/3002
# Test will be on 3099
```

## Summary

- ✅ **Dev and test are completely isolated**
- ✅ **Tests won't kill dev processes**
- ✅ **Use safe cleanup commands only**
- ❌ **Never use broad pkill commands**
- ✅ **Hot reload works during tests**
