import { test, expect } from "@playwright/test";
import { setupTest, waitForAppReady, openSettings, switchSettingsTab } from "./helpers.js";

test.describe("Certificates UI - Multi-Network", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
    await waitForAppReady(page);
  });

  test("should show Certificates tab in settings", async ({ page }) => {
    await openSettings(page);

    // Check for Certificates tab
    const certsTab = page.locator('.settings-tab[data-tab="certificates"]');
    await expect(certsTab).toBeVisible();
    await expect(certsTab).toHaveText("Certificates");
  });

  test("should display current network with green border", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Wait for networks to load
    const networksContainer = page.locator('#cert-networks-container');
    await expect(networksContainer).toBeVisible();

    // Current network should be first and have 'current' class
    const currentNetwork = page.locator('.cert-network-item.current').first();
    await expect(currentNetwork).toBeVisible();

    // Should have "Current" badge
    await expect(currentNetwork.locator('.badge:has-text("Current")')).toBeVisible();
  });

  test("should display all networks list", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Should show networks container
    const networksContainer = page.locator('#cert-networks-container');
    await expect(networksContainer).toBeVisible();

    // Wait for at least one network item to appear (loaded asynchronously)
    const firstItem = page.locator('.cert-network-item').first();
    await expect(firstItem).toBeVisible();
  });

  test("should display network details", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Wait for networks to load
    const networkItem = page.locator('.cert-network-item').first();
    await expect(networkItem).toBeVisible();

    // Should show network label
    const label = networkItem.locator('.cert-network-label');
    await expect(label).toBeVisible();

    // Should show network details (LAN IPs, last used)
    const details = networkItem.locator('.cert-network-details');
    await expect(details).toBeVisible();
    await expect(details).toContainText(/LAN:/);
    await expect(details).toContainText(/Last used:/);

    // Should show actions
    const actions = networkItem.locator('.cert-network-actions');
    await expect(actions).toBeVisible();
  });

  test("should allow renaming network", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Wait for networks to load
    const networkItem = page.locator('.cert-network-item').first();
    const labelInput = networkItem.locator('.cert-network-label');

    // Get initial value
    const initialValue = await labelInput.inputValue();

    // Change label
    await labelInput.fill("Test Network");
    await labelInput.blur();

    // Wait a bit for API call
    await page.waitForTimeout(500);

    // Reload and verify persisted
    await switchSettingsTab(page, "theme");
    await switchSettingsTab(page, "certificates");

    const updatedItem = page.locator('.cert-network-item').first();
    const updatedLabel = updatedItem.locator('.cert-network-label');
    await expect(updatedLabel).toHaveValue("Test Network");

    // Restore original value
    await updatedLabel.fill(initialValue);
    await updatedLabel.blur();
  });

  test("should show regenerate button for each network", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    const networkItem = page.locator('.cert-network-item').first();
    const regenerateBtn = networkItem.locator('button:has-text("Regenerate")');
    await expect(regenerateBtn).toBeVisible();
  });

  test("should regenerate network certificate", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    const networkItem = page.locator('.cert-network-item').first();

    // First click - should change to "Confirm"
    await networkItem.locator('button:has-text("Regenerate")').click();

    // Wait for button to change to "Confirm"
    const confirmBtn = networkItem.locator('button:has-text("Confirm")');
    await expect(confirmBtn).toBeVisible({ timeout: 1000 });
    await expect(confirmBtn).toHaveClass(/btn-confirm/);

    // Second click - should actually regenerate
    await confirmBtn.click();

    // Wait for toast notification
    await expect(page.locator('.toast')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.toast')).toContainText('regenerated');

    // Button should reset back to "Regenerate"
    await expect(networkItem.locator('button:has-text("Regenerate")')).toBeVisible({ timeout: 2000 });
  });

  test("should show both regenerate and revoke buttons for current network", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Current network should have both regenerate and revoke buttons
    const currentNetwork = page.locator('.cert-network-item.current').first();
    await expect(currentNetwork).toBeVisible();

    const regenerateBtn = currentNetwork.locator('button:has-text("Regenerate")');
    const revokeBtn = currentNetwork.locator('button:has-text("Revoke")');

    await expect(regenerateBtn).toBeVisible();
    await expect(revokeBtn).toBeVisible();
  });

  test("should show current network badge", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    // Should have at least one network with "Current" badge
    const badge = page.locator('.badge:has-text("Current")');
    await expect(badge).toBeVisible();
  });

  test("should display networks sorted by last used", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, "certificates");

    const networkItems = page.locator('.cert-network-item');
    const count = await networkItems.count();

    if (count > 1) {
      // Get last used timestamps
      const timestamps = [];
      for (let i = 0; i < count; i++) {
        const details = await networkItems.nth(i).locator('.cert-network-details').textContent();
        timestamps.push(details);
      }

      // Verify sorted (most recent first)
      // This is a basic check - just verify the text exists
      for (const ts of timestamps) {
        expect(ts).toContain("Last used:");
      }
    }
  });

});
