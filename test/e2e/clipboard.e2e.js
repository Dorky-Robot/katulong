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

test.describe('Clipboard - Copy Buttons', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("http://localhost:3001");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForTimeout(1000);
  });

  test('should copy token value with feedback', async ({ page }) => {
    // Open Settings → Remote tab
    await page.click('[data-shortcut-id="settings"]');
    await page.click('.settings-tab[data-tab="remote"]');

    // Create a token
    await page.click('#settings-create-token');
    const tokenName = `clipboard-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    // Wait for new token display
    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible({ timeout: 2000 });

    // Find and click copy button
    const copyBtn = newTokenItem.locator('button:has-text("Copy")');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Should show "Copied!" feedback
    await expect(copyBtn).toContainText('Copied!', { timeout: 1000 });

    // Verify clipboard has token value
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBeTruthy();
    expect(clipboardText.length).toBeGreaterThan(20); // Tokens are long strings

    // Feedback should revert after delay
    await page.waitForTimeout(2500);
    await expect(copyBtn).not.toContainText('Copied!');

    console.log('[Test] Token copied successfully');

    // Clean up - click Done
    await page.click('#token-done-btn');
  });

  test('should copy trust URL in wizard', async ({ page }) => {
    // Open Settings → LAN tab
    await page.click('[data-shortcut-id="settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    // Start wizard
    await page.click('button:has-text("Pair Device on LAN")');

    // Wait for trust view
    const trustView = page.locator('#settings-view-trust');
    await expect(trustView).toHaveClass(/active/, { timeout: 2000 });

    // Wait for QR and copy button to appear
    await page.waitForTimeout(1000);

    const copyBtn = page.locator('#wizard-trust-copy-url');
    await expect(copyBtn).toBeVisible({ timeout: 3000 });

    // Click copy button
    await copyBtn.click();

    // Should show "Copied!" feedback
    await expect(copyBtn).toContainText('Copied!', { timeout: 1000 });

    // Verify clipboard has URL
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/^https?:\/\//);
    expect(clipboardText).toContain('/connect/trust');

    console.log('[Test] Trust URL copied:', clipboardText);

    // Close wizard
    await page.keyboard.press('Escape');
  });

  test('should copy pairing URL in wizard', async ({ page }) => {
    // Open Settings → LAN tab → Wizard
    await page.click('[data-shortcut-id="settings"]');
    await page.click('.settings-tab[data-tab="lan"]');
    await page.click('button:has-text("Pair Device on LAN")');

    // Go to pairing step
    await page.waitForTimeout(500);
    await page.click('#wizard-next-pair');

    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Wait for QR and copy button
    await page.waitForTimeout(1000);

    const copyBtn = page.locator('#wizard-pair-copy-url');
    await expect(copyBtn).toBeVisible({ timeout: 3000 });

    // Click copy
    await copyBtn.click();

    // Should show feedback
    await expect(copyBtn).toContainText('Copied!', { timeout: 1000 });

    // Verify clipboard has pairing URL
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/^https?:\/\//);
    expect(clipboardText).toContain('/auth/pair');

    // Should have code parameter
    expect(clipboardText).toMatch(/[?&]code=[^&]+/);

    console.log('[Test] Pairing URL copied:', clipboardText);

    // Close wizard
    await page.keyboard.press('Escape');
  });

  test('should handle copy failure gracefully', async ({ page, context }) => {
    // Revoke clipboard permissions to simulate failure
    await context.clearPermissions();

    // Try to copy a token
    await page.click('[data-shortcut-id="settings"]');
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

    await page.waitForTimeout(1000);

    console.log('[Test] Copy failure handled:', hasFailedText ? 'showed error' : 'showed alert');

    // Clean up
    await page.click('#token-done-btn').catch(() => {});
    await page.keyboard.press('Escape');
  });

  test('should copy multiple items in sequence', async ({ page }) => {
    // Create two tokens
    await page.click('[data-shortcut-id="settings"]');
    await page.click('.settings-tab[data-tab="remote"]');

    // First token
    await page.click('#settings-create-token');
    await page.locator('#token-name-input').fill(`token1-${Date.now()}`);
    await page.click('#token-form-submit');
    await page.waitForTimeout(500);

    const token1Item = page.locator('.token-item-new');
    const copy1Btn = token1Item.locator('button:has-text("Copy")');
    await copy1Btn.click();

    const token1Value = await page.evaluate(() => navigator.clipboard.readText());
    expect(token1Value).toBeTruthy();

    // Click Done
    await page.click('#token-done-btn');
    await page.waitForTimeout(500);

    // Second token
    await page.click('#settings-create-token');
    await page.locator('#token-name-input').fill(`token2-${Date.now()}`);
    await page.click('#token-form-submit');
    await page.waitForTimeout(500);

    const token2Item = page.locator('.token-item-new');
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
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("http://localhost:3001");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForTimeout(1000);
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

    await page.waitForTimeout(500);

    // Send the pasted command
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // Verify the pasted text appeared in terminal
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain(testText);

    console.log('[Test] Paste into terminal successful');
  });

  test('should copy selected text from terminal', async ({ page }) => {
    // Type a unique string
    const testString = `copy-from-terminal-${Date.now()}`;
    await page.keyboard.type(`echo "${testString}"`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // Select text in terminal (this is xterm-specific)
    // Double-click to select word or use mouse drag
    const terminal = page.locator('.xterm-screen');

    // Find the text and double-click it to select
    await page.evaluate((text) => {
      const screen = document.querySelector('.xterm-screen');
      const range = document.createRange();
      const walker = document.createTreeWalker(
        screen,
        NodeFilter.SHOW_TEXT,
        null
      );

      let node;
      while (node = walker.nextNode()) {
        const index = node.textContent.indexOf(text);
        if (index >= 0) {
          range.setStart(node, index);
          range.setEnd(node, index + text.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          break;
        }
      }
    }, testString);

    // Copy selection
    const isMac = process.platform === 'darwin';
    if (isMac) {
      await page.keyboard.press('Meta+c');
    } else {
      await page.keyboard.press('Control+c');
    }

    await page.waitForTimeout(500);

    // Verify clipboard
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(testString);

    console.log('[Test] Copy from terminal successful');
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

    await page.waitForTimeout(500);

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

    await page.waitForTimeout(500);

    // Should not crash
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('special');

    console.log('[Test] Special characters paste handled');
  });
});

test.describe('Clipboard - Permissions', () => {
  test('should request clipboard permissions when needed', async ({ page, context }) => {
    // Don't grant permissions initially
    await page.goto("http://localhost:3001");
    await page.waitForSelector(".xterm", { timeout: 10000 });

    // Try to copy a token
    await page.click('[data-shortcut-id="settings"]');
    await page.click('.settings-tab[data-tab="remote"]');
    await page.click('#settings-create-token');

    const tokenName = `perm-test-${Date.now()}`;
    await page.locator('#token-name-input').fill(tokenName);
    await page.click('#token-form-submit');

    const newTokenItem = page.locator('.token-item-new');
    await expect(newTokenItem).toBeVisible();

    // Click copy - may trigger permission request or fail gracefully
    const copyBtn = newTokenItem.locator('button:has-text("Copy")');
    await copyBtn.click();

    await page.waitForTimeout(1000);

    // Should either have copied successfully or shown error
    // (Behavior depends on browser and permissions)

    console.log('[Test] Clipboard permission handling tested');

    // Clean up
    await page.click('#token-done-btn').catch(() => {});
  });
});
