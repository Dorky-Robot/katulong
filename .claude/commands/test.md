Run the test suite for katulong. Accepts an optional scope: unit, integration, e2e, smoke, or all.

## Instructions

You are running tests for katulong. The argument `$ARGUMENTS` is an optional test scope. If empty, run the default suite (`npm test` — unit + integration).

### Step 1: Kill conflicting processes

E2E tests start their own server on ports 3001/3002. Check for and kill any processes occupying those ports:

```bash
lsof -ti:3001 | xargs kill -9 2>/dev/null || true
lsof -ti:3002 | xargs kill -9 2>/dev/null || true
```


### Step 2: Determine which tests to run

Parse `$ARGUMENTS`:

- Empty or `default` → `npm test` (unit + integration)
- `unit` → `npm run test:unit`
- `integration` → `npm run test:integration`
- `e2e` → `npm run test:e2e`
- `smoke` → `npm run test:e2e:smoke`
- `all` → `npm run test:all`
- A file path (e.g., `test/auth.test.js`) → `node --experimental-test-module-mocks --test <file>`
- A pattern (e.g., `auth`) → find matching test files and run them

Tell the user which suite you're running before starting.

### Step 3: Run the tests

Execute the appropriate test command. Let it run to completion — do not interrupt.

### Step 4: Report results

If all tests pass, report success with the count of passing tests.

If tests fail:

1. Read the failing test file(s) to understand what they test
2. Read the source file(s) they test to understand the expected behavior
3. Diagnose the root cause — is it a test bug or a code bug?
4. Report your findings:
   - Which tests failed and why
   - Whether the issue is in the test or the source code
   - A recommended fix

Do NOT automatically fix failing tests. Present the diagnosis and ask the user whether to fix the tests, fix the code, or skip.

### Step 5: Handle port conflicts

If tests fail with `EADDRINUSE`:

1. Identify which process holds the port: `lsof -ti:<port>`
2. Kill it: `kill -9 <pid>`
3. Re-run the failing tests

If tests fail with timeout errors, check if a dev server is running that interferes.
