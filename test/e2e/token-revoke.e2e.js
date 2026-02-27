/**
 * E2E test for token revoke functionality
 *
 * Tests that revoking a token actually removes it from the UI and server.
 * Regression test for bug where revoked tokens still appeared in the list.
 */

import { test, expect } from '@playwright/test';
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe('Token Revoke', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should remove revoked token from UI and server', async ({ page }) => {
    // Navigate to Remote tab
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    // Wait for token list to load
    await page.waitForFunction(
      () => document.querySelector('#tokens-list') !== null,
      { timeout: 5000 }
    );

    // Get all tokens and pick the first one that's not linked to a credential
    const initialCount = await page.locator('.token-item').count();

    // If there are no tokens, create one via API first
    if (initialCount === 0) {
      const testToken = await page.evaluate(async () => {
        const res = await fetch('/api/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `revoke-test-${Date.now()}` })
        });
        return res.json();
      });

      // Trigger a reload of the token store
      await page.evaluate(() => {
        window.location.reload();
      });
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
        // Skip tokens with "Active device" (they're linked to credentials)
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

    // If no suitable token found, skip test
    if (!tokenToRevoke) {
      console.log('[Test] No suitable token found for revoke test - skipping');
      return;
    }

    const tokenName = tokenToRevoke;
    const countBeforeRevoke = await page.locator('.token-item').count();

    // Set up dialog handler for confirm
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept(); // Confirm the revoke
    });

    // Find and click Revoke button for the token
    const tokenItem = page.locator('.token-item').filter({ hasText: tokenName });
    await tokenItem.locator('button[data-action="revoke"]').click();

    // Wait for token to be removed from UI (optimistic update)
    await expect(tokenItem).not.toBeVisible({ timeout: 3000 });

    // Verify token count decreased
    const countAfterRevoke = await page.locator('.token-item').count();
    expect(countAfterRevoke).toBe(countBeforeRevoke - 1);

    // Reload page and verify token is still gone (server-side deletion worked)
    await page.reload();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    // Wait for token list to finish loading
    await page.waitForFunction(
      () => document.querySelector('#tokens-list') !== null,
      { timeout: 5000 }
    );

    // Token should not reappear after reload
    const tokenExists = await page.locator('.token-item').filter({ hasText: tokenName }).count();
    expect(tokenExists).toBe(0);

    console.log('[Test] Token revoke successful - removed from UI and server');
  });

  test('should handle revoke of token that was used for device registration', async ({ page }) => {
    // This test would need a way to create a token and use it to register a device
    // For now, we'll just verify the confirm dialog shows the right message

    await openSettings(page);
    await switchSettingsTab(page, 'remote');

    // Look for a token that has "Active device" status
    const activeToken = page.locator('.token-item').filter({ hasText: 'Active device' }).first();
    const hasActiveToken = await activeToken.count() > 0;

    if (hasActiveToken) {
      // Set up dialog handler to check message and cancel
      page.once('dialog', async dialog => {
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('device');
        expect(dialog.message()).toContain('lose access');
        await dialog.dismiss(); // Cancel - don't actually revoke
      });

      await activeToken.locator('button[data-action="revoke"]').click();

      // Token should still be there since we cancelled
      await expect(activeToken).toBeVisible();
    } else {
      console.log('[Test] No active device tokens to test');
    }
  });
});
