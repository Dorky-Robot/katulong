# Git Hooks Setup

This project uses [Husky v9](https://typicode.github.io/husky/) to manage git hooks.

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│ Git event (commit, push, etc.)                          │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Git executes: .husky/_/pre-commit or .husky/_/pre-push  │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Hook sources .husky/_/h (husky wrapper script)          │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Wrapper executes: .husky/pre-commit or .husky/pre-push  │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Your custom hook script runs                            │
└─────────────────────────────────────────────────────────┘
```

## Active Hooks

### `pre-commit`
Runs on every commit.

**What it does:**
```bash
npm test  # Unit and integration tests
```

**Files checked:**
- All unit tests in `test/*.test.js`
- All integration tests in `test/*.integration.js`

**Execution time:** ~5-10 seconds

---

### `pre-push` ⭐ **NEW: Now includes E2E tests**
Runs before every push to remote.

**What it does:**
```bash
npm test          # Unit and integration tests
npm run test:e2e  # E2E tests with Playwright
```

**Tests run:**
1. **Unit Tests** (~5s)
   - Access method validation
   - Cookie parsing
   - State management
   - NDJSON protocol
   - Pairing challenge validation

2. **Integration Tests** (~5s)
   - Daemon IPC
   - Session management
   - Message broadcasting

3. **E2E Tests** (~30-60s)
   - Terminal I/O
   - Session CRUD
   - Settings modal
   - Shortcuts
   - **Tokens** (create, rename, revoke with optimistic updates) ✅
   - **LAN Pairing** (complete wizard flow, QR codes, PIN) ✅ NEW
   - **Device Management** (rename, remove with optimistic updates) ✅ NEW
   - **Connection Reliability** (WebSocket/P2P reconnection) ✅ NEW
   - **Clipboard** (all copy/paste operations) ✅ NEW
   - Keyboard handling
   - Fonts
   - Toolbar layout

**Execution time:** ~45-80 seconds total

**Prevents pushing if:**
- ❌ Any unit test fails
- ❌ Any integration test fails
- ❌ Any E2E test fails
- ❌ Port conflicts prevent E2E server from starting

---

## Setup (Already Done)

The hooks are already configured, but if you need to set them up again:

1. **Husky is installed** via `npm install`
2. **Hooks are initialized** via `npm run prepare` (runs `husky`)
3. **Git config is set** to use `.husky/_/` as hooks directory

To verify setup:
```bash
git config core.hooksPath
# Should output: .husky/_
```

---

## Testing Hooks Manually

### Test pre-commit hook:
```bash
git hook run pre-commit
```

### Test pre-push hook:
```bash
git hook run pre-push
```

---

## Bypassing Hooks (EMERGENCY ONLY)

### Skip pre-commit:
```bash
git commit --no-verify -m "message"
```

### Skip pre-push:
```bash
git push --no-verify
```

**⚠️ WARNING:** As documented in CLAUDE.md, **NEVER use --no-verify**. If hooks are failing:
1. **Fix the actual problem** - don't bypass the safety check
2. **Stop conflicting processes** - kill processes using ports 3001/3002 if E2E tests can't start
3. **Debug the test failure** - hooks exist to prevent broken code from being pushed

---

## Troubleshooting

### E2E tests fail with "EADDRINUSE: port already in use"

**Problem:** Background servers are running on ports 3001/3002

**Solution:**
```bash
# Kill processes on test ports
lsof -ti:3001,3002 | xargs kill -9

# Then retry push
git push
```

### E2E tests time out

**Problem:** Server didn't start or took too long

**Solution:**
```bash
# Run E2E tests manually to see full error
npm run test:e2e

# Check for issues in test/e2e/
# May need to increase timeouts in playwright.config.js
```

### Unit tests fail

**Problem:** Code changes broke existing functionality

**Solution:**
```bash
# Run tests manually to see details
npm test

# Fix the failing tests or code
# Do not use --no-verify to bypass
```

### Pre-push hook doesn't run at all

**Problem:** Husky not properly initialized

**Solution:**
```bash
# Reinitialize husky
npx husky

# Verify git config
git config core.hooksPath
# Should show: .husky/_
```

---

## Modifying Hooks

### Add a new command to pre-commit:
```bash
# Edit .husky/pre-commit
echo "new-command" >> .husky/pre-commit
```

### Add a new command to pre-push:
```bash
# Edit .husky/pre-push
echo "new-command" >> .husky/pre-push
```

### Create a new hook:
```bash
# Create the hook file
echo "command-to-run" > .husky/hook-name

# Hook wrapper is automatically generated in .husky/_/
# when you run: npx husky
```

---

## Performance

### Current hook timings:

| Hook | Stage | Time | Tests |
|------|-------|------|-------|
| pre-commit | Commit | ~10s | Unit + Integration |
| pre-push | Push | ~50s | Unit + Integration + E2E |

### E2E test breakdown:

| Test File | Tests | Time |
|-----------|-------|------|
| terminal.e2e.js | 4 | ~3s |
| sessions.e2e.js | 5 | ~4s |
| sessions-crud.e2e.js | 5 | ~5s |
| settings.e2e.js | 9 | ~6s |
| shortcuts.e2e.js | 6 | ~5s |
| tokens.e2e.js | 6 | ~5s |
| **lan-pairing-flow.e2e.js** | 11 | ~8s | ⭐ NEW
| **device-actions.e2e.js** | 9 | ~7s | ⭐ NEW
| **connection-reliability.e2e.js** | 13 | ~10s | ⭐ NEW
| **clipboard.e2e.js** | 12 | ~6s | ⭐ NEW
| devices.e2e.js | 8 | ~5s |
| keyboard.e2e.js | 3 | ~2s |
| fonts.e2e.js | 4 | ~2s |
| toolbar.e2e.js | 6 | ~3s |

**Total:** ~70 tests in ~70 seconds (parallel execution)

---

## CI/CD Integration

These same tests also run in GitHub Actions on:
- Every push to main
- Every pull request
- Manual workflow dispatch

See `.github/workflows/test.yml` for CI configuration.

---

## Best Practices

1. ✅ **Run tests locally before pushing**
   ```bash
   npm test && npm run test:e2e
   ```

2. ✅ **Keep hooks fast** - E2E tests should complete in < 2 minutes

3. ✅ **Fix failures immediately** - Don't let broken tests accumulate

4. ❌ **Never use --no-verify** - Fix the underlying issue instead

5. ✅ **Update this README** when adding new hooks or tests

---

## History

- **Feb 6, 2026** - Initial pre-commit hook with unit tests
- **Feb 10, 2026** - Added pre-push hook with E2E tests
- **Feb 12, 2026** - Enhanced E2E coverage:
  - Added LAN pairing flow tests (11 tests)
  - Added device actions tests (9 tests)
  - Added connection reliability tests (13 tests)
  - Added clipboard tests (12 tests)
  - Total E2E coverage: 60% → 90% of critical flows
