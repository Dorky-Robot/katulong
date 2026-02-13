/**
 * Global setup for E2E tests
 * Runs once before all tests
 */

import { chromium } from '@playwright/test';
import { setupTestFixtures } from './fixtures.js';

const TEST_PORT = 3099;

export default async function globalSetup() {
  console.log('\n[Global Setup] Preparing test environment...\n');

  // Note: Test data directory and fixture auth state are created by pre-server-setup.js
  // which runs BEFORE the webServer starts (via playwright.config.js command chain)

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Navigate to app - server has already loaded the fixture auth.json created by pre-server-setup
    await page.goto(`http://localhost:${TEST_PORT}`);
    await page.waitForSelector('.xterm', { timeout: 10000 });

    // Setup additional test fixtures (check devices, create extra tokens, etc.)
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
