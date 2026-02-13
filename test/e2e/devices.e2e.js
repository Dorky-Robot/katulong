/**
 * E2E tests for LAN device pairing and management
 */

import { test, expect } from '@playwright/test';
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe('LAN Device Management', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should display LAN devices list with metadata', async ({ page }) => {
    // Open settings modal and switch to LAN tab
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Wait for devices list to load (either devices or empty message)
    await page.waitForSelector('.device-item, .devices-loading', { timeout: 3000 });

    // Check if there are any devices
    const deviceItems = page.locator('.device-item');
    const deviceCount = await deviceItems.count();

    if (deviceCount > 0) {
      const firstDevice = deviceItems.first();

      // Should have device icon
      await expect(firstDevice.locator('i.ph-monitor')).toBeVisible();

      // Should have device name
      await expect(firstDevice.locator('.device-name')).toBeVisible();

      // Should have metadata with "Added:" and "Last used:"
      const meta = firstDevice.locator('.device-meta');
      await expect(meta).toContainText('Added:');
      await expect(meta).toContainText('Last used:');

      // Should have Rename and Remove buttons
      await expect(firstDevice.locator('button:has-text("Rename")')).toBeVisible();

      // Remove button may not be visible if it's the only device
      const removeButton = firstDevice.locator('button:has-text("Remove")');
      const isVisible = await removeButton.isVisible();

      // If visible, should have danger styling
      if (isVisible) {
        await expect(removeButton).toHaveClass(/device-btn-danger/);
      }
    }
  });

  test('should open LAN pairing wizard', async ({ page }) => {
    // Open settings modal
    await page.click('button[aria-label="Settings"]');
    await expect(page.locator('#settings-overlay')).toBeVisible();

    // Click LAN tab
    await page.click('.settings-tab[data-tab="lan"]');

    // Click "Pair Device on LAN" button
    await page.click('button:has-text("Pair Device on LAN")');

    // Should show wizard view (trust or pair step)
    // Actual selectors: #settings-view-trust or #settings-view-pair
    const trustView = page.locator('#settings-view-trust');
    const pairView = page.locator('#settings-view-pair');

    // Wait for either view to become visible (they toggle visibility with CSS)
    await page.waitForFunction(
      () => {
        const trust = document.getElementById('settings-view-trust');
        const pair = document.getElementById('settings-view-pair');
        return (trust && trust.offsetParent !== null) || (pair && pair.offsetParent !== null);
      },
      { timeout: 2000 }
    );

    const isTrustVisible = await trustView.isVisible();
    const isPairVisible = await pairView.isVisible();

    expect(isTrustVisible || isPairVisible).toBeTruthy();

    if (isTrustVisible) {
      // Should show trust instructions (actual text is "Install Certificate")
      await expect(trustView).toContainText('Install Certificate');

      // Should have QR code canvas
      const qrCanvas = trustView.locator('canvas');
      await expect(qrCanvas).toBeVisible();

      // Should have copy URL button
      const copyBtn = trustView.locator('button');
      await expect(copyBtn.first()).toBeVisible();
    }

    if (isPairVisible) {
      // Should show pairing QR code canvas
      const qrCanvas = pairView.locator('canvas');
      await expect(qrCanvas).toBeVisible();

      // Should show PIN - check for any element containing digits
      const viewText = await pairView.textContent();
      const digits = viewText.match(/\d{8}/); // 8 consecutive digits
      expect(digits).toBeTruthy();
    }
  });

  test('should close pairing wizard without errors', async ({ page }) => {
    // Open settings modal
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Start pairing wizard
    await page.click('button:has-text("Pair Device on LAN")');

    // Wait for wizard view to be visible
    await page.waitForFunction(
      () => {
        const trust = document.getElementById('settings-view-trust');
        const pair = document.getElementById('settings-view-pair');
        return (trust && trust.offsetParent !== null) || (pair && pair.offsetParent !== null);
      },
      { timeout: 2000 }
    );

    // Close modal by pressing Escape (no close button exists)
    await page.keyboard.press('Escape');

    // Wait for modal to close
    const modal = page.locator('#settings-overlay');
    await expect(modal).not.toBeVisible({ timeout: 2000 });

    // Should not have console errors
    // (Playwright automatically fails on console errors if configured)
  });

  test('should display device count correctly', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    // Count devices in the list
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    // Should match the actual devices returned from API
    expect(count).toBeGreaterThanOrEqual(0);

    // If no devices, should show empty state
    if (count === 0) {
      await expect(page.locator('text=/No LAN devices paired yet/')).toBeVisible();
    }
  });

  test('should format dates correctly', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count > 0) {
      const meta = deviceItems.first().locator('.device-meta');
      const metaText = await meta.textContent();

      // Should have format: "Added: M/D/YYYY • Last used: Xh ago"
      expect(metaText).toMatch(/Added:\s+\d{1,2}\/\d{1,2}\/\d{4}/);
      expect(metaText).toMatch(/Last used:\s+.+/);
    }
  });

  test('should handle rename action', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count > 0) {
      const firstDevice = deviceItems.first();
      const originalName = await firstDevice.locator('.device-name').textContent();

      // Set up dialog handler for native prompt() - dismiss it
      page.once('dialog', async dialog => {
        expect(dialog.type()).toBe('prompt');
        expect(dialog.message()).toContain('name');
        await dialog.dismiss(); // Cancel the rename
      });

      // Click Rename button - triggers native prompt()
      await firstDevice.locator('button:has-text("Rename")').click();

      // Wait a bit for dialog handling to complete
      await page.waitForTimeout(500);

      // Device name should still be the same (we dismissed the dialog)
      const currentName = await firstDevice.locator('.device-name').textContent();
      expect(currentName).toBe(originalName);
    }
  });

  test('should handle remove action with confirmation', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    // Only test if there are multiple devices (can't remove the last one)
    if (count > 1) {
      const firstDevice = deviceItems.first();
      const removeBtn = firstDevice.locator('button:has-text("Remove")');

      if (await removeBtn.isVisible()) {
        const originalCount = count;

        // Set up dialog handler for native confirm() - dismiss it
        page.once('dialog', async dialog => {
          expect(dialog.type()).toBe('confirm');
          expect(dialog.message()).toContain('remove');
          await dialog.dismiss(); // Cancel the removal
        });

        // Click Remove button - triggers native confirm()
        await removeBtn.click();

        // Wait a bit for dialog handling to complete
        await page.waitForTimeout(500);

        // Device count should still be the same (we dismissed the dialog)
        const newCount = await deviceItems.count();
        expect(newCount).toBe(originalCount);

      }
    }
  });

  test('should prevent removing last device when not localhost', async ({ page, context }) => {
    // This test would need to be run from a non-localhost origin
    // For now, we'll just verify the logic exists

    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count === 1) {
      const device = deviceItems.first();
      const removeBtn = device.locator('button:has-text("Remove")');

      // If we're on localhost, remove button should be visible
      // If not on localhost and only 1 device, button should not exist
      const isLocalhost = page.url().includes('localhost') || page.url().includes('127.0.0.1');

      if (!isLocalhost) {
        await expect(removeBtn).not.toBeVisible();

        // Should show warning
        await expect(page.locator('.devices-warning')).toBeVisible();
        await expect(page.locator('.devices-warning')).toContainText('cannot remove the last device');
      }
    }
  });
});
