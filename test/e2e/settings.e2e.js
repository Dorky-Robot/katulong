import { test, expect } from "@playwright/test";
import { setupTest, openSettings, switchSettingsTab, waitForDialogClose } from './helpers.js';

test.describe("Settings modal", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
    await openSettings(page);
  });

  test("Opens when gear icon is clicked", async ({ page }) => {
    // openSettings already verified the dialog is visible
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test("Theme toggle has Auto, Light, and Dark buttons", async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Auto' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Light' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Dark' })).toBeVisible();
  });

  test("Switching theme updates the active button", async ({ page }) => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Light' }).click();

    // Light should now be selected (pressed)
    await expect(dialog.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Auto' })).not.toHaveAttribute('aria-pressed', 'true');
  });

  test("End Session button is hidden on localhost", async ({ page }) => {
    // Switch to Remote tab
    await switchSettingsTab(page, 'Remote');

    // E2E tests run on localhost, so logout button should be hidden
    // (localhost bypasses auth - it's root/admin access)
    const logout = page.getByRole('button', { name: 'End Session' });
    await expect(logout).toBeHidden();
  });

  test("Pressing Escape closes the modal", async ({ page }) => {
    const dialog = page.getByRole('dialog').filter({ hasText: 'Settings' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });

  test("Theme persists after reload", async ({ page }) => {
    const dialog = page.getByRole('dialog');

    // Switch to light theme
    await dialog.getByRole('button', { name: 'Light' }).click();

    // Close modal and reload
    await page.keyboard.press('Escape');
    await waitForDialogClose(page, 'Settings');
    await page.reload();
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });

    // Re-open settings and verify light is still active
    await openSettings(page);
    const newDialog = page.getByRole('dialog');
    await expect(newDialog.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');

    // Reset to auto
    await newDialog.getByRole('button', { name: 'Auto' }).click();
  });
});
