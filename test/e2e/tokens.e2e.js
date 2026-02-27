import { test, expect } from "@playwright/test";
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe("Setup Tokens", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test("Create token - should appear in list immediately", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    // Click "Generate New Token" button
    await dialog.getByRole('button', { name: 'Generate New Token' }).click();

    // Form should appear
    const nameInput = dialog.getByRole('textbox', { name: 'Token name' });
    await expect(nameInput).toBeVisible();

    // Enter token name
    const tokenName = `test-token-${Date.now()}`;
    await nameInput.fill(tokenName);

    // Submit form
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Wait for form to disappear and new token display to appear
    await expect(nameInput).not.toBeVisible({ timeout: 5000 });

    // Should show the new token with copy button
    await expect(dialog.getByText(tokenName)).toBeVisible({ timeout: 2000 });
    await expect(dialog.getByText('Save this token now')).toBeVisible();

    // Copy button should work
    const copyBtn = dialog.getByRole('button', { name: 'Copy' });
    await copyBtn.click();
    await expect(dialog.getByText('Copied!')).toBeVisible({ timeout: 2000 });

    // Token creation successful
  });

  test("Cancel token creation", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    // Click "Generate New Token"
    await dialog.getByRole('button', { name: 'Generate New Token' }).click();

    // Form should appear
    const nameInput = dialog.getByRole('textbox', { name: 'Token name' });
    await expect(nameInput).toBeVisible();

    // Enter a name
    await nameInput.fill("cancel-test");

    // Click cancel
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Form should disappear
    await expect(nameInput).not.toBeVisible({ timeout: 5000 });

    // Generate button should reappear
    await expect(dialog.getByRole('button', { name: 'Generate New Token' })).toBeVisible();
  });

  test("Press Enter to submit form", async ({ page }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'Remote');

    const dialog = page.getByRole('dialog');

    await dialog.getByRole('button', { name: 'Generate New Token' }).click();

    const tokenName = `enter-test-${Date.now()}`;
    const nameInput = dialog.getByRole('textbox', { name: 'Token name' });
    await nameInput.fill(tokenName);

    // Press Enter
    await nameInput.press("Enter");

    // Form should disappear and new token display should appear
    await expect(nameInput).not.toBeVisible({ timeout: 5000 });
    await expect(dialog.getByText(tokenName)).toBeVisible({ timeout: 2000 });
  });
});
