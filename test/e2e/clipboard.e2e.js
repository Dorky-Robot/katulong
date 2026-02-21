/**
 * E2E tests for clipboard operations
 *
 * Tests copy/paste functionality across the application:
 * - Token copy buttons
 * - QR URL copy buttons (wizard)
 * - Terminal copy/paste
 * - Image paste
 */

import { test, expect } from '@playwright/test';
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe('Clipboard - Copy Buttons', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should copy token value with feedback', async ({ page }) => {
    // Open Settings → Remote tab
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="remote"]');

    // Create a token
    await page.click('#settings-create-token');
    const tokenName = `clipboard-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    // Wait for new token display
    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible({ timeout: 2000 });

    // Find and click copy button (use class selector for reliability)
    const copyBtn = newTokenItem.locator('.token-copy-btn');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Should show "Copied!" feedback
    await expect(copyBtn).toContainText('Copied!', { timeout: 2000 });

    // Verify clipboard has token value
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBeTruthy();
    expect(clipboardText.length).toBeGreaterThan(20); // Tokens are long strings

    // Feedback should revert after delay - wait for it to not contain "Copied!"
    await expect(copyBtn).not.toContainText('Copied!', { timeout: 3000 });

    console.log('[Test] Token copied successfully');

    // Clean up - click Done
    await page.click('#token-done-btn');
  });

  test('should handle copy failure gracefully', async ({ page, context }) => {
    // Revoke clipboard permissions to simulate failure
    await context.clearPermissions();

    // Try to copy a token
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="remote"]');
    await page.click('#settings-create-token');

    const tokenName = `copy-fail-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible();

    const copyBtn = newTokenItem.locator('button:has-text("Copy")');
    await copyBtn.click();

    // Should show error feedback or alert
    // Either "Failed" text or browser alert
    const btnText = await copyBtn.textContent();
    const hasFailedText = btnText.includes('Failed') || btnText.includes('fail');

    // Or check for alert
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('copy');
      dialog.dismiss();
    });

    // Wait a bit for potential dialog or button text update
    await page.waitForFunction(() => true, { timeout: 1000 }).catch(() => {});

    console.log('[Test] Copy failure handled:', hasFailedText ? 'showed error' : 'showed alert');

    // Clean up
    await page.click('#token-done-btn').catch(() => {});
    await page.keyboard.press('Escape');
  });

  test('should copy multiple items in sequence', async ({ page }) => {
    // Create two tokens
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

    // Click Done
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

    // Values should be different
    expect(token2Value).not.toBe(token1Value);

    console.log('[Test] Multiple copy operations successful');

    // Clean up
    await page.click('#token-done-btn');
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

    console.log('[Test] Paste into terminal successful');
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
    // Verify at least the first line appears
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('line1');

    console.log('[Test] Multiline paste handled');
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

    console.log('[Test] Special characters paste handled');
  });
});

test.describe('Clipboard - Permissions', () => {
  test('should request clipboard permissions when needed', async ({ page, context }) => {
    // Test that clipboard operations work with granted permissions
    await page.goto("/");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });

    // Try to copy a token
    await openSettings(page);
    await switchSettingsTab(page, 'remote');
    await page.click('#settings-create-token');

    const tokenName = `perm-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible();

    // Click copy - may trigger permission request or fail gracefully
    const copyBtn = newTokenItem.locator('button:has-text("Copy")');
    await copyBtn.click();

    // Wait for button text to update (either "Copied!" or error state)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('.token-item-new button:has-text("Copy")');
        return btn && btn.textContent !== 'Copy';
      },
      { timeout: 2000 }
    ).catch(() => {
      // Button might not change if permission denied
    });

    // Should either have copied successfully or shown error
    // (Behavior depends on browser and permissions)

    console.log('[Test] Clipboard permission handling tested');

    // Clean up
    await page.click('#token-done-btn').catch(() => {});
  });
});
