/**
 * E2E Test Helpers
 *
 * Common utilities for Playwright tests to avoid waitForTimeout anti-pattern
 */

import { expect } from '@playwright/test';

/**
 * Setup test environment - grants permissions and navigates to app
 */
export async function setupTest({ page, context }) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("http://localhost:3001");
  await waitForAppReady(page);
}

/**
 * Wait for app to be ready (terminal loaded)
 */
export async function waitForAppReady(page) {
  await page.waitForSelector(".xterm", { timeout: 10000 });
  // Wait for terminal to be interactive (not just visible)
  await page.waitForSelector(".xterm-screen", { timeout: 5000 });
}

/**
 * Open settings modal and wait for it to be ready
 */
export async function openSettings(page) {
  await page.click('[data-shortcut-id="settings"]');
  const modal = page.locator('.modal[data-modal-id="settings"]');
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * Switch to a settings tab and wait for it to be active
 */
export async function switchSettingsTab(page, tabName) {
  await page.click(`.settings-tab[data-tab="${tabName}"]`);
  // Wait for tab content to be visible
  await page.waitForSelector(`#settings-tab-${tabName}`, { state: 'visible' });
}

/**
 * Wait for modal to close
 */
export async function waitForModalClose(page, modalId) {
  const modal = page.locator(`.modal[data-modal-id="${modalId}"]`);
  await expect(modal).not.toBeVisible();
}

/**
 * Type command and wait for output
 */
export async function typeCommand(page, command) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  // Wait for command to appear in terminal
  await page.waitForFunction(
    (cmd) => document.querySelector('.xterm-screen')?.textContent?.includes(cmd),
    command,
    { timeout: 5000 }
  );
}

/**
 * Wait for terminal output to contain text
 */
export async function waitForOutput(page, text) {
  await page.waitForFunction(
    (txt) => document.querySelector('.xterm-screen')?.textContent?.includes(txt),
    text,
    { timeout: 5000 }
  );
}
