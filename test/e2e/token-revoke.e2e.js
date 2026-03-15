/**
 * E2E test for token revoke functionality
 *
 * Tests that revoking a token actually removes it from the UI and server.
 * Regression test for bug where revoked tokens still appeared in the list.
 */

import { test, expect } from '@playwright/test';
import { setupTest, cleanupSession, openSettings, switchSettingsTab } from './helpers.js';

test.describe('Token Revoke', () => {
  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test('should remove revoked token from UI and server', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    await page.waitForFunction(
      () => document.querySelector('#tokens-list') !== null,
      { timeout: 5000 }
    );

    const initialCount = await page.locator('.token-item').count();

    // If there are no tokens, create one via API first
    if (initialCount === 0) {
      await page.evaluate(async () => {
        await fetch('/api/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `revoke-test-${Date.now()}` })
        });
      });

      await page.evaluate(() => { window.location.reload(); });
      await page.waitForSelector('.xterm', { timeout: 10000 });
      await openSettings(page);
      await switchSettingsTab(page, 'remote');
      await page.waitForFunction(
        () => document.querySelectorAll('.token-item').length > 0,
        { timeout: 5000 }
      );
    }

    // Get a token to revoke (preferably one without a credential)
    const tokenToRevoke = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.token-item'));
      for (const item of items) {
        if (!item.textContent.includes('Active device')) {
          const nameEl = item.querySelector('.token-name');
          const revokeBtn = item.querySelector('button[data-action="revoke"]');
          if (nameEl && revokeBtn) {
            return nameEl.textContent.trim();
          }
        }
      }
      return null;
    });

    if (!tokenToRevoke) {
      test.skip(true, 'No suitable token found for revoke test');
      return;
    }

    const tokenName = tokenToRevoke;
    const countBeforeRevoke = await page.locator('.token-item').count();

    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept();
    });

    const tokenItem = page.locator('.token-item').filter({ hasText: tokenName });
    await tokenItem.locator('button[data-action="revoke"]').click();

    await expect(tokenItem).not.toBeVisible({ timeout: 3000 });

    const countAfterRevoke = await page.locator('.token-item').count();
    expect(countAfterRevoke).toBe(countBeforeRevoke - 1);

    // Reload page and verify token is still gone (server-side deletion worked)
    await page.reload();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    await page.waitForFunction(
      () => document.querySelector('#tokens-list') !== null,
      { timeout: 5000 }
    );

    const tokenExists = await page.locator('.token-item').filter({ hasText: tokenName }).count();
    expect(tokenExists).toBe(0);
  });

  test('should handle revoke of token that was used for device registration', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    const activeToken = page.locator('.token-item').filter({ hasText: 'Active device' }).first();
    const hasActiveToken = await activeToken.count() > 0;

    if (!hasActiveToken) {
      test.skip(true, 'No active device tokens to test');
      return;
    }

    // Verify the confirm dialog warns about device access loss, then cancel
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('device');
      expect(dialog.message()).toContain('lose access');
      await dialog.dismiss(); // Cancel - don't actually revoke
    });

    await activeToken.locator('button[data-action="revoke"]').click();

    // Token should still be there since we cancelled
    await expect(activeToken).toBeVisible();
  });
});
