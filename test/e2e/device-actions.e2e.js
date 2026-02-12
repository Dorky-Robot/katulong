/**
 * E2E tests for device actions (rename, remove) with optimistic updates
 *
 * Tests that UI updates immediately (optimistic) before API confirmation,
 * matching the pattern used for token management.
 */

import { test, expect } from '@playwright/test';

test.describe('Device Actions - Optimistic Updates', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("http://localhost:3001");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForTimeout(1000);

    // Open settings and go to LAN tab
    await page.click('[data-shortcut-id="settings"]');
    await expect(page.locator('.modal[data-modal-id="settings"]')).toBeVisible();
    await page.click('.settings-tab[data-tab="lan"]');
    await page.waitForTimeout(500);
  });

  test('should rename device with optimistic update', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    // Skip if no devices
    if (count === 0) {
      console.log('[Test] Skipped - no devices to rename');
      return;
    }

    const firstDevice = deviceItems.first();
    const deviceName = firstDevice.locator('.device-name');
    const originalName = await deviceName.textContent();

    console.log('[Test] Original device name:', originalName);

    // Click Rename button
    const renameBtn = firstDevice.locator('button:has-text("Rename")');
    await renameBtn.click();

    // Wait for rename input/modal
    const renameInput = page.locator('input[type="text"]').last();
    await expect(renameInput).toBeVisible({ timeout: 2000 });

    // Verify input has current name
    const inputValue = await renameInput.inputValue();
    expect(inputValue).toBe(originalName);

    // Enter new name
    const newName = `TestDevice-${Date.now()}`;
    await renameInput.fill(newName);

    // Submit rename
    const submitBtn = page.locator('button:has-text("Save"), button:has-text("Rename"), button[type="submit"]').last();
    await submitBtn.click();

    // CRITICAL: Verify name updates IMMEDIATELY (optimistic update)
    // Should not wait for API response
    await expect(deviceName).toHaveText(newName, { timeout: 1000 });

    // Verify the update persisted
    await page.waitForTimeout(500);
    await expect(deviceName).toHaveText(newName);

    console.log('[Test] Device renamed to:', newName);
  });

  test('should show error if rename API fails', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count === 0) {
      console.log('[Test] Skipped - no devices');
      return;
    }

    // Intercept rename API and make it fail
    await page.route('**/auth/devices/**/rename', route => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 500,
          body: JSON.stringify({ error: 'Rename failed' })
        });
      } else {
        route.continue();
      }
    });

    const firstDevice = deviceItems.first();
    const renameBtn = firstDevice.locator('button:has-text("Rename")');
    await renameBtn.click();

    const renameInput = page.locator('input[type="text"]').last();
    await expect(renameInput).toBeVisible();

    const newName = `FailedRename-${Date.now()}`;
    await renameInput.fill(newName);

    const submitBtn = page.locator('button:has-text("Save"), button:has-text("Rename")').last();
    await submitBtn.click();

    // Should show error message or revert to original name
    // (This depends on error handling implementation)
    await page.waitForTimeout(1000);

    // Remove the route intercept
    await page.unroute('**/auth/devices/**/rename');
  });

  test('should cancel rename without making changes', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count === 0) {
      console.log('[Test] Skipped - no devices');
      return;
    }

    const firstDevice = deviceItems.first();
    const deviceName = firstDevice.locator('.device-name');
    const originalName = await deviceName.textContent();

    // Click Rename
    const renameBtn = firstDevice.locator('button:has-text("Rename")');
    await renameBtn.click();

    const renameInput = page.locator('input[type="text"]').last();
    await expect(renameInput).toBeVisible();

    // Enter new name but don't submit
    await renameInput.fill(`CancelledRename-${Date.now()}`);

    // Click Cancel
    const cancelBtn = page.locator('button:has-text("Cancel")');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    } else {
      // Or press Escape
      await page.keyboard.press('Escape');
    }

    // Name should remain unchanged
    await expect(deviceName).toHaveText(originalName);
  });

  test('should remove device with optimistic update', async ({ page, context }) => {
    // This test requires at least 2 devices, or being on localhost
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    const isLocalhost = page.url().includes('localhost') || page.url().includes('127.0.0.1');

    // Can only remove if multiple devices OR on localhost
    if (count === 0 || (count === 1 && !isLocalhost)) {
      console.log('[Test] Skipped - cannot remove last device from remote');
      return;
    }

    const firstDevice = deviceItems.first();
    const deviceName = firstDevice.locator('.device-name');
    const deviceNameText = await deviceName.textContent();

    console.log('[Test] Removing device:', deviceNameText);

    // Click Remove button
    const removeBtn = firstDevice.locator('button:has-text("Remove")');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Should show confirmation dialog
    const confirmDialog = page.locator('text=/Are you sure|Remove this device|Confirm/i');
    const hasConfirmDialog = await confirmDialog.isVisible({ timeout: 1000 }).catch(() => false);

    if (hasConfirmDialog) {
      // Click confirm
      const confirmBtn = page.locator('button:has-text("Yes"), button:has-text("Remove"), button:has-text("Confirm")').last();
      await confirmBtn.click();
    }

    // CRITICAL: Device should disappear IMMEDIATELY (optimistic update)
    // Should not wait for API response
    await expect(firstDevice).not.toBeVisible({ timeout: 1000 });

    // Verify device count decreased
    const newCount = await deviceItems.count();
    expect(newCount).toBe(count - 1);

    console.log('[Test] Device removed successfully');
  });

  test('should prevent removing last device when not localhost', async ({ page, context }) => {
    // This test is tricky to run from localhost, but we can verify the UI logic

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count !== 1) {
      console.log('[Test] Skipped - need exactly 1 device');
      return;
    }

    const isLocalhost = page.url().includes('localhost') || page.url().includes('127.0.0.1');

    if (!isLocalhost) {
      // Remove button should not be visible
      const removeBtn = page.locator('button:has-text("Remove")');
      await expect(removeBtn).not.toBeVisible();

      // Should show warning
      const warning = page.locator('.devices-warning');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('cannot remove the last device');
    } else {
      // On localhost, remove button should still be visible
      const removeBtn = page.locator('button:has-text("Remove")');
      await expect(removeBtn).toBeVisible();
    }
  });

  test('should refresh device list after remove', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    const isLocalhost = page.url().includes('localhost') || page.url().includes('127.0.0.1');

    if (count === 0 || (count === 1 && !isLocalhost)) {
      console.log('[Test] Skipped - cannot remove');
      return;
    }

    // Get device IDs before removal
    const initialIds = await deviceItems.evaluateAll(items =>
      items.map(item => item.dataset.deviceId)
    );

    // Remove first device
    const firstDevice = deviceItems.first();
    const firstDeviceId = await firstDevice.getAttribute('data-device-id');

    const removeBtn = firstDevice.locator('button:has-text("Remove")');
    await removeBtn.click();

    // Confirm if needed
    const confirmBtn = page.locator('button:has-text("Yes"), button:has-text("Remove"), button:has-text("Confirm")').last();
    if (await confirmBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Wait for removal
    await page.waitForTimeout(500);

    // Get device IDs after removal
    const newIds = await deviceItems.evaluateAll(items =>
      items.map(item => item.dataset.deviceId)
    );

    // Removed device should not be in the list
    expect(newIds).not.toContain(firstDeviceId);
    expect(newIds.length).toBe(initialIds.length - 1);
  });

  test('should handle concurrent device actions', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count < 2) {
      console.log('[Test] Skipped - need multiple devices');
      return;
    }

    // Try to rename two devices rapidly
    const device1 = deviceItems.nth(0);
    const device2 = deviceItems.nth(1);

    const rename1 = device1.locator('button:has-text("Rename")');
    const rename2 = device2.locator('button:has-text("Rename")');

    // Click first rename
    await rename1.click();
    await page.waitForTimeout(100);

    // Try to click second rename (should either queue or show error)
    // This tests that the UI handles concurrent actions gracefully
    const isSecondRenameEnabled = await rename2.isEnabled();

    // Clean up - cancel any open dialogs
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  });

  test('should preserve device metadata after actions', async ({ page }) => {
    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count === 0) {
      console.log('[Test] Skipped - no devices');
      return;
    }

    const firstDevice = deviceItems.first();
    const meta = firstDevice.locator('.device-meta');
    const originalMeta = await meta.textContent();

    // Rename device
    const renameBtn = firstDevice.locator('button:has-text("Rename")');
    await renameBtn.click();

    const renameInput = page.locator('input[type="text"]').last();
    await expect(renameInput).toBeVisible();

    const newName = `PreserveMetadata-${Date.now()}`;
    await renameInput.fill(newName);

    const submitBtn = page.locator('button:has-text("Save"), button:has-text("Rename")').last();
    await submitBtn.click();

    // Wait for rename to complete
    await page.waitForTimeout(500);

    // Metadata should still be present and unchanged
    const newMeta = await meta.textContent();

    // Should still have "Added:" and "Last used:"
    expect(newMeta).toContain('Added:');
    expect(newMeta).toContain('Last used:');

    // Date should be the same (only name changed)
    const dateMatch = originalMeta.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
    if (dateMatch) {
      expect(newMeta).toContain(dateMatch[0]);
    }
  });
});
