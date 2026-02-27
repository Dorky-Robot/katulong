/**
 * E2E test for token revoke functionality
 *
 * Tests that revoking a token actually removes it from the UI and server.
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
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    // If there are no tokens, create one via API first
    const initialTokens = await page.evaluate(async () => {
      const res = await fetch('/api/tokens');
      const data = await res.json();
      return data.tokens || [];
    });

    if (initialTokens.length === 0) {
      // Create a token
      const testToken = await page.evaluate(async () => {
        const res = await fetch('/api/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: `revoke-test-${Date.now()}` })
        });
        return res.json();
      });

      // Reload to refresh the token list
      await page.reload();
      await page.waitForSelector('.xterm', { timeout: 10000 });
      await openSettings(page);
      await switchSettingsTab(page, 'Remote');
    }

    // Find a token to revoke (use ARIA selectors)
    const tokenItems = page.getByLabel(/Token:/);
    const initialCount = await tokenItems.count();

    if (initialCount === 0) {
      console.log('[Test] No tokens found - skipping');
      return;
    }

    // Get the first token's name
    const firstToken = tokenItems.first();
    const tokenLabel = await firstToken.getAttribute('aria-label');
    const tokenName = tokenLabel?.replace('Token: ', '') || '';

    // Set up dialog handler for confirm
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept();
    });

    // Click revoke (trash) button for the first token
    const revokeBtn = firstToken.getByRole('button', { name: 'Revoke token' });
    await revokeBtn.click();

    // Wait for token to be removed from UI
    await expect(firstToken).not.toBeVisible({ timeout: 5000 });

    // Verify token count decreased
    const afterCount = await tokenItems.count();
    expect(afterCount).toBe(initialCount - 1);

    // Reload and verify token is still gone (server-side deletion worked)
    await page.reload();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    // Token should not reappear after reload
    const tokenExists = await page.getByLabel(`Token: ${tokenName}`).count();
    expect(tokenExists).toBe(0);
  });

  test('should handle revoke of token with linked device', async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    // Look for a token with "Active device" text
    const activeToken = page.getByLabel(/Token:/).filter({ hasText: 'Active device' }).first();
    const hasActiveToken = await activeToken.count() > 0;

    if (hasActiveToken) {
      // Set up dialog handler to check message and cancel
      page.once('dialog', async dialog => {
        expect(dialog.type()).toBe('confirm');
        expect(dialog.message()).toContain('device');
        expect(dialog.message()).toContain('lose access');
        await dialog.dismiss(); // Cancel - don't actually revoke
      });

      await activeToken.getByRole('button', { name: 'Revoke token' }).click();

      // Token should still be there since we cancelled
      await expect(activeToken).toBeVisible();
    } else {
      console.log('[Test] No active device tokens to test');
    }
  });
});
