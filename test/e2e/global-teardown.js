/**
 * Global teardown for E2E tests
 * Runs once after all tests complete
 */

import { rmSync } from 'fs';
import { TEST_DATA_DIR, TEST_SOCK_PATH } from './test-config.js';

export default async function globalTeardown() {
  console.log('\n[Global Teardown] Cleaning up test environment...\n');

  // Clean test data directory after running tests
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('[Global Teardown] Test data directory cleaned');
  } catch (error) {
    console.log('[Global Teardown] Warning: Could not clean test directory:', error.message);
  }

  // Remove daemon socket to prevent EADDRINUSE on next run
  try {
    rmSync(TEST_SOCK_PATH, { force: true });
  } catch (error) {
    // Socket may already be cleaned up by the daemon
  }

  console.log('[Global Teardown] Cleanup complete\n');
}
