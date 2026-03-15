/**
 * Global teardown for E2E tests
 * Runs once after all tests complete
 */

import { rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { TEST_DATA_DIR } from './test-config.js';

const TEST_SESSION_PREFIXES = [
  'smoke-', 'kb-', 'term-io-', 'fb-', 'e2e-', 'test-', 'iso-', 'tab-switch-', 'responsive-switch-'
];

export default async function globalTeardown() {
  // Clean test data directory after running tests
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (error) {
    console.log('[Global Teardown] Warning: Could not clean test directory:', error.message);
  }

  // Kill leftover test tmux sessions
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    const sessions = output.trim().split('\n').filter(s =>
      TEST_SESSION_PREFIXES.some(prefix => s.startsWith(prefix))
    );
    for (const sess of sessions) {
      try { execFileSync('tmux', ['kill-session', '-t', sess]); } catch { /* already dead */ }
    }
    if (sessions.length > 0) {
      console.log(`[Global Teardown] Killed ${sessions.length} test tmux sessions`);
    }
  } catch { /* no tmux or no sessions */ }
}
