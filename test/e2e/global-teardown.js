/**
 * Global teardown for E2E tests
 * Runs once after all tests complete
 */

import { rmSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { TEST_DATA_DIR } from './test-config.js';

export default async function globalTeardown() {
  console.log('\n[Global Teardown] Cleaning up test environment...\n');

  // Clean test data directory after running tests
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('[Global Teardown] Test data directory cleaned');
  } catch (error) {
    console.log('[Global Teardown] Warning: Could not clean test directory:', error.message);
  }

  // Kill leftover smoke test tmux sessions
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' })
      .trim().split('\n').filter(s => s.startsWith('smoke-'));
    for (const sess of sessions) {
      try { execFileSync('tmux', ['kill-session', '-t', sess]); } catch { /* already dead */ }
    }
    if (sessions.length > 0) {
      console.log(`[Global Teardown] Killed ${sessions.length} smoke tmux sessions`);
    }
  } catch { /* no tmux or no sessions */ }

  console.log('[Global Teardown] Cleanup complete\n');
}
