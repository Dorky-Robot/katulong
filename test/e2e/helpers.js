/**
 * E2E Test Helpers
 *
 * Common utilities for Playwright tests to avoid waitForTimeout anti-pattern
 */

import { expect } from '@playwright/test';

/**
 * Setup test environment - grants permissions, navigates to app with a unique session name.
 * Returns the session name for cleanup.
 */
export async function setupTest({ page, context, testInfo }) {
  const sessionName = testInfo
    ? `e2e-${testInfo.testId}-${Date.now()}`
    : `e2e-fallback-${Date.now()}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
  await waitForAppReady(page);
  await page.locator(".xterm-helper-textarea").focus();
  return sessionName;
}

/**
 * Clean up a named session via the DELETE API.
 *
 * Resolves the friendly name to its stable surrogate id via GET /sessions,
 * then DELETEs the by-id route. The name-keyed DELETE was removed in MC1e
 * PR3c; every mutation now goes through the immutable id.
 */
export async function cleanupSession(page, sessionName) {
  if (!sessionName) return;
  try {
    await page.evaluate(async (name) => {
      const res = await fetch("/sessions");
      if (!res.ok) return;
      const list = await res.json();
      const match = Array.isArray(list) && list.find((s) => s && s.name === name);
      if (!match || typeof match.id !== "string") return;
      await fetch(`/sessions/by-id/${encodeURIComponent(match.id)}`, { method: "DELETE" });
    }, sessionName);
  } catch {
    // page may already be closed
  }
}

/**
 * Wait for the shell prompt to appear in the terminal.
 * Bridges the gap between "terminal DOM visible" and "shell ready to accept input".
 */
export async function waitForShellReady(page) {
  await page.waitForFunction(
    () => /[$➜❯%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
    { timeout: 60000 },
  );
}

/**
 * Wait for app to be ready (terminal loaded and shell prompt visible)
 */
export async function waitForAppReady(page) {
  await page.waitForSelector(".xterm", { timeout: 10000 });
  await page.waitForSelector(".xterm-screen", { timeout: 5000 });
  await waitForShellReady(page);
}

/**
 * Open settings modal and wait for it to be ready
 */
export async function openSettings(page) {
  await page.click('#key-island .key-island-btn[aria-label="Settings"]');
  const modal = page.locator('#settings-overlay');
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
