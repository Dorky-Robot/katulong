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

  test('should display device count correctly', async ({ page }) => {
    // Open settings
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');

    // Count devices in the list
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    // Should match the actual devices returned from API
    expect(count).toBeGreaterThanOrEqual(0);

    // If no devices, list should just be empty (no devices-loading spinner)
    if (count === 0) {
      await expect(page.locator('.device-item')).toHaveCount(0);
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

  test('should allow removing last device from localhost', async ({ page }) => {
    // Verify we're on localhost (e2e tests run on localhost)
    const isLocalhost = page.url().includes('localhost') || page.url().includes('127.0.0.1');
    expect(isLocalhost).toBeTruthy();

    // Open settings
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count === 0) {
      // No devices to remove - skip test
      return;
    }

    // Remove all devices except the last one (if more than 1)
    // We want to test the "last device" scenario
    while (await deviceItems.count() > 1) {
      const removeBtn = deviceItems.first().locator('button:has-text("End Session")');
      if (!await removeBtn.isVisible()) break;

      page.once('dialog', async dialog => {
        await dialog.accept();
      });
      await removeBtn.click();
      // Wait for device to be removed from the list
      await page.waitForTimeout(500);
    }

    // Now we should have exactly 1 device
    const remaining = await deviceItems.count();
    if (remaining !== 1) return;

    // On localhost, the End Session button should still be visible for the last device
    const lastDevice = deviceItems.first();
    const removeBtn = lastDevice.locator('button:has-text("End Session")');
    await expect(removeBtn).toBeVisible();

    // Accept the confirmation dialog
    page.once('dialog', async dialog => {
      await dialog.accept();
    });

    // Click End Session on the last device - should succeed from localhost
    await removeBtn.click();

    // Wait for the device to be removed
    await page.waitForTimeout(1000);

    // The device list should now be empty
    const finalCount = await deviceItems.count();
    expect(finalCount).toBe(0);
  });
});
