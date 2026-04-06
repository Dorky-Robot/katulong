/**
 * Global teardown for E2E tests
 * Runs once after all tests complete
 */

import { rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { TEST_DATA_DIR, TEST_TMUX_SOCKET } from './test-config.js';

export default async function globalTeardown() {
  // Clean test data directory after running tests
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (error) {
    console.log('[Global Teardown] Warning: Could not clean test directory:', error.message);
  }

  // Kill the entire per-shard test tmux server in one shot.
  //
  // Previously we scanned the default socket and killed sessions by prefix,
  // which was fragile (missed auto-named `session-*` sessions and the short
  // `smoke-*`-prefix match never held up once new test fixtures were added)
  // AND dangerous — it was running on the developer's production tmux
  // socket, so any misfiring match could kill real sessions.
  //
  // Now that the test server runs under `tmux -L <TEST_TMUX_SOCKET>`, we
  // just kill the whole server. No prefix matching, no risk of touching
  // the developer's default socket.
  try {
    execFileSync('tmux', ['-L', TEST_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
    console.log(`[Global Teardown] Killed test tmux server on socket ${TEST_TMUX_SOCKET}`);
  } catch { /* no server running — already torn down */ }
}
