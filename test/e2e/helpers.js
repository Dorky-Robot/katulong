/**
 * E2E Test Helpers
 *
 * Common utilities for Playwright tests.
 * Supports both the legacy HTML frontend and Flutter Web (CanvasKit) frontend.
 *
 * Flutter renders UI to <canvas> with a Semantics tree for accessibility.
 * xterm.js is embedded via HtmlElementView and retains its normal DOM.
 * Use ARIA-based locators (getByRole, getByLabel) for Flutter UI elements.
 */

import { expect } from '@playwright/test';

/**
 * Setup test environment - grants permissions and navigates to app
 */
export async function setupTest({ page, context }) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await waitForAppReady(page);
  await page.locator(".xterm-helper-textarea").focus();
}

/**
 * Wait for the shell prompt to appear in the terminal.
 * Bridges the gap between "terminal DOM visible" and "shell ready to accept input".
 */
export async function waitForShellReady(page) {
  await page.waitForFunction(
    () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
  );
}

/**
 * Wait for app to be ready (terminal loaded and shell prompt visible)
 */
export async function waitForAppReady(page) {
  // xterm.js lives in a platform view — its DOM elements are always present
  await page.waitForSelector(".xterm", { timeout: 10000 });
  await page.waitForSelector(".xterm-screen", { timeout: 5000 });
  await waitForShellReady(page);
}

/**
 * Open settings modal and wait for it to be ready.
 * Works with both legacy (CSS selector) and Flutter (ARIA) frontends.
 */
export async function openSettings(page) {
  // Flutter: Semantics tree generates role=button with aria-label
  const settingsBtn = page.getByRole('button', { name: 'Settings' });
  await settingsBtn.click();
  // Wait for settings dialog to appear
  const dialog = page.getByRole('dialog').filter({ hasText: 'Settings' });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  return dialog;
}

/**
 * Switch to a settings tab
 */
export async function switchSettingsTab(page, tabName) {
  const tab = page.getByRole('tab', { name: tabName });
  await tab.click();
}

/**
 * Wait for a dialog to close
 */
export async function waitForDialogClose(page, titleText) {
  const dialog = page.getByRole('dialog').filter({ hasText: titleText });
  await expect(dialog).not.toBeVisible({ timeout: 5000 });
}

// Legacy alias
export const waitForModalClose = waitForDialogClose;

/**
 * Type command and wait for output
 */
export async function typeCommand(page, command) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
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
