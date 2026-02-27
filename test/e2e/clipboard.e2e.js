/**
 * E2E tests for clipboard operations
 *
 * Tests copy/paste functionality across the application:
 * - Token copy buttons
 * - Terminal copy/paste
 */

import { test, expect } from '@playwright/test';
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe('Clipboard - Copy Buttons', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should copy token value with feedback', async ({ page }) => {
    // Open Settings > Remote tab
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    // Create a token
    await dialog.getByRole('button', { name: 'Generate New Token' }).click();
    const tokenName = `clipboard-test-${Date.now()}`;
    await dialog.getByRole('textbox', { name: 'Token name' }).fill(tokenName);
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Wait for new token display
    await expect(dialog.getByText('Save this token now')).toBeVisible({ timeout: 2000 });

    // Click copy button
    const copyBtn = dialog.getByRole('button', { name: 'Copy' });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Should show "Copied!" feedback
    await expect(dialog.getByText('Copied!')).toBeVisible({ timeout: 2000 });

    // Verify clipboard has token value
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBeTruthy();
    expect(clipboardText.length).toBeGreaterThan(20); // Tokens are long strings

    // Feedback should revert after delay
    await expect(dialog.getByText('Copied!')).not.toBeVisible({ timeout: 5000 });

    // Clean up - click Done
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('should handle copy failure gracefully', async ({ page, context }) => {
    // Revoke clipboard permissions to simulate failure
    await context.clearPermissions();

    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    await dialog.getByRole('button', { name: 'Generate New Token' }).click();
    const tokenName = `copy-fail-test-${Date.now()}`;
    await dialog.getByRole('textbox', { name: 'Token name' }).fill(tokenName);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog.getByText('Save this token now')).toBeVisible({ timeout: 2000 });

    const copyBtn = dialog.getByRole('button', { name: 'Copy' });
    await copyBtn.click();

    // Wait for potential error handling
    await page.waitForTimeout(1000);

    // Clean up
    await dialog.getByRole('button', { name: 'Done' }).click().catch(() => {});
    await page.keyboard.press('Escape');
  });

  test('should copy multiple items in sequence', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    // First token
    await dialog.getByRole('button', { name: 'Generate New Token' }).click();
    await dialog.getByRole('textbox', { name: 'Token name' }).fill(`token1-${Date.now()}`);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog.getByText('Save this token now')).toBeVisible({ timeout: 2000 });
    const copy1Btn = dialog.getByRole('button', { name: 'Copy' });
    await copy1Btn.click();

    const token1Value = await page.evaluate(() => navigator.clipboard.readText());
    expect(token1Value).toBeTruthy();

    // Click Done
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Second token
    await dialog.getByRole('button', { name: 'Generate New Token' }).click();
    await dialog.getByRole('textbox', { name: 'Token name' }).fill(`token2-${Date.now()}`);
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog.getByText('Save this token now')).toBeVisible({ timeout: 2000 });
    const copy2Btn = dialog.getByRole('button', { name: 'Copy' });
    await copy2Btn.click();

    const token2Value = await page.evaluate(() => navigator.clipboard.readText());
    expect(token2Value).toBeTruthy();

    // Values should be different
    expect(token2Value).not.toBe(token1Value);

    // Clean up
    await dialog.getByRole('button', { name: 'Done' }).click();
  });
});

test.describe('Clipboard - Terminal Integration', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should paste text into terminal', async ({ page }) => {
    // Set clipboard content
    const testText = `paste-test-${Date.now()}`;
    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, testText);

    // Focus terminal
    await page.click('.xterm');

    // Paste using Cmd+V (Mac) or Ctrl+V (Linux/Windows)
    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    // Send the pasted command
    await page.keyboard.press('Enter');

    // Wait for output to appear
    await page.waitForFunction(
      (text) => document.querySelector('.xterm-screen')?.textContent?.includes(text),
      testText,
      { timeout: 5000 }
    );

    // Verify the pasted text appeared in terminal
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain(testText);
  });

  test('should handle paste of multiline text', async ({ page }) => {
    const multilineText = `line1-${Date.now()}\nline2\nline3`;

    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, multilineText);

    await page.click('.xterm');

    // Paste
    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    // Wait for pasted content to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('line1'),
      { timeout: 5000 }
    );

    // Multiline paste should work
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('line1');
  });

  test('should handle paste of special characters', async ({ page }) => {
    const specialChars = `special-$@!#%^&*()-=+{}[]|\\:;"'<>?,./~\`${Date.now()}`;

    await page.evaluate(text => {
      navigator.clipboard.writeText(text);
    }, specialChars);

    await page.click('.xterm');

    // Paste
    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+v');
    } else {
      await page.keyboard.press('Control+v');
    }

    // Wait for pasted content to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('special'),
      { timeout: 5000 }
    );

    // Should not crash
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('special');
  });
});
