/**
 * Global setup for E2E tests
 * Runs once before all tests
 */

import { chromium } from '@playwright/test';
import { setupTestFixtures } from './fixtures.js';
import { rmSync } from 'fs';

const TEST_PORT = 3099;
const TEST_DATA_DIR = '/tmp/katulong-e2e-data';

export default async function globalSetup() {
  console.log('\n[Global Setup] Preparing test environment...\n');

  // Clean test data directory before running tests
  try {
    console.log('[Global Setup] Cleaning test data directory...');
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    console.log('[Global Setup] Test data directory cleaned');
  } catch (error) {
    console.log('[Global Setup] Note: Could not clean test directory (may not exist yet)');
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Navigate to app
    await page.goto(`http://localhost:${TEST_PORT}`);
    await page.waitForSelector('.xterm', { timeout: 10000 });

    // Setup test fixtures
    await setupTestFixtures(page);

    console.log('\n[Global Setup] Test environment ready\n');
  } catch (error) {
    console.error('[Global Setup] Failed:', error.message);
    // Don't fail tests if fixtures can't be created
    console.log('[Global Setup] Continuing anyway - some tests may be skipped\n');
  } finally {
    await browser.close();
  }
}
