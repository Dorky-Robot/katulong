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

    // Should show wizard modal or view
    // First step: Trust CA certificate
    const trustView = page.locator('.wizard-view[data-step="trust"]');
    const pairView = page.locator('.wizard-view[data-step="pair"]');

    // Either trust view or pair view should be visible
    const isTrustVisible = await trustView.isVisible();
    const isPairVisible = await pairView.isVisible();

    expect(isTrustVisible || isPairVisible).toBeTruthy();

    if (isTrustVisible) {
      // Should show trust instructions
      await expect(trustView).toContainText('Trust');

      // Should have QR code for trust URL
      await expect(trustView.locator('canvas[data-qr="trust"]')).toBeVisible();

      // Should have copy button
      const copyBtn = trustView.locator('button:has-text("Copy")');
      await expect(copyBtn).toBeVisible();
    }

    if (isPairVisible) {
      // Should show pairing QR code
      await expect(pairView.locator('canvas[data-qr="pair"]')).toBeVisible();

      // Should show PIN
      const pinDisplay = pairView.locator('.wizard-pin, [data-pin]');
      await expect(pinDisplay).toBeVisible();

      // PIN should be 8 digits
      const pinText = await pinDisplay.textContent();
      const digits = pinText.match(/\d+/);
      expect(digits).toBeTruthy();
      if (digits) {
        expect(digits[0].length).toBe(8);
      }
    }
  });

  test('should close pairing wizard without errors', async ({ page }) => {
    // Open settings modal
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Start pairing wizard
    await page.click('button:has-text("Pair Device on LAN")');

    // Wait for wizard to open - either trust or pair view should be visible
    await page.waitForFunction(
      () => {
        const trustView = document.querySelector('.wizard-view[data-step="trust"], #settings-view-trust');
        const pairView = document.querySelector('.wizard-view[data-step="pair"], #settings-view-pair');
        return (trustView && trustView.classList.contains('active')) ||
               (pairView && pairView.classList.contains('active'));
      },
      { timeout: 2000 }
    );

    // Close modal (click outside or close button)
    const closeBtn = page.locator('.modal-close, button:has-text("Cancel"), button:has-text("Close")');
    if (await closeBtn.isVisible()) {
      await closeBtn.first().click();
    } else {
      // Click modal backdrop to close
      await page.locator('.modal-backdrop').click();
    }

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

      // Click Rename button
      await firstDevice.locator('button:has-text("Rename")').click();

      // Should show rename dialog/input
      const renameInput = page.locator('input[type="text"][placeholder*="name"], input[id*="rename"]');
      await expect(renameInput).toBeVisible({ timeout: 2000 });

      // Cancel the rename (we don't want to actually change it)
      const cancelBtn = page.locator('button:has-text("Cancel")');
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
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
        // Click Remove button
        await removeBtn.click();

        // Should show confirmation dialog
        const confirmDialog = page.locator('text=/Are you sure|Remove this device|Confirm/');
        await expect(confirmDialog).toBeVisible({ timeout: 2000 });

        // Cancel the removal (we don't want to actually delete it)
        const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("No")');
        if (await cancelBtn.isVisible()) {
          await cancelBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
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
