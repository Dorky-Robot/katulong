/**
 * E2E tests for clipboard operations
 *
 * Tests copy/paste functionality across the application:
 * - Token copy buttons
 * - Terminal copy/paste
 */

import { test, expect } from '@playwright/test';
import { setupTest, cleanupSession, openSettings, switchSettingsTab } from './helpers.js';

test.describe('Clipboard - Copy Buttons', () => {
  // Copy button tests only need the settings UI, not the terminal shell
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.waitForSelector("#shortcut-bar", { timeout: 10000 });
  });

  test('should copy token value with feedback', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    await page.click('#settings-create-token');
    const tokenName = `clipboard-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible({ timeout: 2000 });

    const copyBtn = newTokenItem.locator('.token-copy-btn');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    await expect(copyBtn).toContainText('Copied!', { timeout: 2000 });

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBeTruthy();
    expect(clipboardText.length).toBeGreaterThan(20);

    await expect(copyBtn).not.toContainText('Copied!', { timeout: 3000 });

    await page.click('#token-done-btn');
  });

  test('should copy multiple items in sequence', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    // First token
    await page.click('#settings-create-token');
    await page.locator('#token-name-input').fill(`token1-${Date.now()}`);
    await page.click('#token-form-submit');

    const token1Item = page.locator('.token-item-new');
    await expect(token1Item).toBeVisible({ timeout: 2000 });
    const copy1Btn = token1Item.locator('button:has-text("Copy")');
    await copy1Btn.click();

    const token1Value = await page.evaluate(() => navigator.clipboard.readText());
    expect(token1Value).toBeTruthy();

    await page.click('#token-done-btn');
    await expect(token1Item).not.toBeVisible();

    // Second token
    await page.click('#settings-create-token');
    await page.locator('#token-name-input').fill(`token2-${Date.now()}`);
    await page.click('#token-form-submit');

    const token2Item = page.locator('.token-item-new');
    await expect(token2Item).toBeVisible({ timeout: 2000 });
    const copy2Btn = token2Item.locator('button:has-text("Copy")');
    await copy2Btn.click();

    const token2Value = await page.evaluate(() => navigator.clipboard.readText());
    expect(token2Value).toBeTruthy();

    expect(token2Value).not.toBe(token1Value);

    await page.click('#token-done-btn');
  });
});

test.describe('Clipboard - Terminal Integration', () => {
  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test('should paste text into terminal', async ({ page }) => {
    const testText = `paste-test-${Date.now()}`;
    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, testText);

    await page.click('.xterm');

    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    await page.keyboard.press('Enter');

    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      testText,
      { timeout: 5000 }
    );

    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain(testText);
  });

  test('should handle paste of multiline text', async ({ page }) => {
    const multilineText = `line1-${Date.now()}\nline2\nline3`;

    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, multilineText);

    await page.click('.xterm');

    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('line1'),
      { timeout: 5000 }
    );

    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('line1');
  });

  test('should handle paste of special characters', async ({ page }) => {
    const specialChars = `special-$@!#%^&*()-=+{}[]|\\:;"'<>?,./~\`${Date.now()}`;

    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, specialChars);

    await page.click('.xterm');

    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('special'),
      { timeout: 5000 }
    );

    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('special');
  });
});
