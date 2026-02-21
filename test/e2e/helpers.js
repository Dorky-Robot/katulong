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
  await page.goto("/");
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
  await page.click('button[aria-label="Settings"]');
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
 * Wait for the xterm buffer to contain text.
 *
 * Reads window.__xterm.buffer.active rather than .xterm-screen.textContent
 * because the canvas renderer's accessibility layer only exposes the current
 * cursor row; output on previous rows disappears from the DOM once the shell
 * returns to a prompt. The internal xterm buffer retains all scrollback lines.
 *
 * Requires window.__xterm to be set in the app (set by app.js after term.open()).
 */
export async function waitForTerminalOutput(page, text, { timeout = 10000 } = {}) {
  await page.waitForFunction(
    (searchText) => {
      const term = window.__xterm;
      if (!term) return false;
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)?.translateToString(true);
        if (line?.includes(searchText)) return true;
      }
      return false;
    },
    text,
    { timeout }
  );
}

/**
 * Read the entire xterm buffer as a string (all rows including scrollback).
 *
 * Use this instead of page.locator('.xterm-screen').textContent() to get
 * reliable access to terminal history on canvas renderers.
 */
export async function readTerminalBuffer(page) {
  return page.evaluate(() => {
    const term = window.__xterm;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)?.translateToString(true);
      if (line) lines.push(line);
    }
    return lines.join('\n');
  });
}

/**
 * Type command and wait for output
 */
export async function typeCommand(page, command) {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await waitForTerminalOutput(page, command);
}

/**
 * Wait for terminal output to contain text
 */
export async function waitForOutput(page, text) {
  await waitForTerminalOutput(page, text);
}
