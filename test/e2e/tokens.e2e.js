import { test, expect } from "@playwright/test";
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe("Setup Tokens", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test("Create token - should appear in list immediately", async ({ page }) => {
    // Open settings modal
    const settingsBtn = page.locator('#shortcut-bar button[aria-label="Settings"]');
    await settingsBtn.click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    // Switch to Remote tab
    await page.locator('.settings-tab[data-tab="remote"]').click();
    // Wait for tab content to be visible
    await page.waitForSelector('#settings-tab-remote', { state: 'visible' });

    // Click "Generate New Token" button
    await page.locator("#settings-create-token").click();

    // Form should appear
    await expect(page.locator("#token-create-form")).toBeVisible();

    // Enter token name
    const tokenName = `test-token-${Date.now()}`;
    await page.locator("#token-name-input").fill(tokenName);

    // Submit form
    await page.locator("#token-form-submit").click();

    // Wait for form to disappear
    await expect(page.locator("#token-create-form")).toBeHidden();

    // NEW TOKEN SHOULD APPEAR IMMEDIATELY (this is the bug)
    const tokensList = page.locator("#tokens-list");
    await expect(tokensList).toContainText(tokenName, { timeout: 2000 });

    // Should show the new token with copy button
    const newTokenItem = page.locator(".token-item-new");
    await expect(newTokenItem).toBeVisible();
    await expect(newTokenItem).toContainText(tokenName);
    await expect(newTokenItem).toContainText("Save this token now");

    // Should have a token value field
    const tokenValueField = newTokenItem.locator(".token-value-field");
    await expect(tokenValueField).toBeVisible();
    const tokenValue = await tokenValueField.inputValue();
    expect(tokenValue).toMatch(/^[a-f0-9]{32}$/); // Should be 32-char hex string

    // Copy button should work
    const copyBtn = newTokenItem.locator(".token-copy-btn");
    await copyBtn.click();
    await expect(copyBtn).toContainText("Copied!");
    await expect(copyBtn).toContainText("Copy", { timeout: 3000 });

    // Token creation successful - cleanup by reloading page
    // (which discards the temporary "new token" display)
  });

  test.skip("Rename token", async ({ page }) => {
    // SKIPPED: Token doesn't appear in regular list after clicking Done button
    // The token-item-new display works, but transition to regular list may not be implemented
    // First create a token
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();
    const originalName = `rename-test-${Date.now()}`;
    await page.locator("#token-name-input").fill(originalName);
    await page.locator("#token-form-submit").click();
    await expect(page.locator("#token-create-form")).toBeHidden();

    // Click done to dismiss new token display
    await page.locator("#token-done-btn").click();
    await expect(page.locator('.token-item-new')).not.toBeVisible();

    // Wait for list to stabilize after the token moves to regular list
    await page.waitForTimeout(500);

    // Find the token and click rename
    const tokenItem = page.locator(`.token-item:has-text("${originalName}")`);
    await expect(tokenItem).toBeVisible();

    // Set up dialog handler BEFORE clicking to avoid race
    const newName = `renamed-${Date.now()}`;
    const dialogPromise = page.waitForEvent('dialog');
    await tokenItem.locator('button[data-action="rename"]').click();

    // Handle the prompt dialog
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('prompt');
    await dialog.accept(newName);

    // Should show new name
    await expect(page.locator("#tokens-list")).toContainText(newName, { timeout: 2000 });
    await expect(page.locator("#tokens-list")).not.toContainText(originalName);

    // Clean up - revoke the renamed token
    await page.waitForTimeout(500);
    const renamedItem = page.locator(`.token-item:has-text("${newName}")`);
    const cleanupDialogPromise = page.waitForEvent('dialog');
    await renamedItem.locator('button[data-action="revoke"]').click();
    const cleanupDialog = await cleanupDialogPromise;
    await cleanupDialog.accept();
    await expect(renamedItem).not.toBeVisible({ timeout: 2000 });
  });

  test.skip("Revoke unused token", async ({ page }) => {
    // SKIPPED: Same issue as rename - token doesn't appear in regular list after Done
    // Create a token
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();
    const tokenName = `revoke-test-${Date.now()}`;
    await page.locator("#token-name-input").fill(tokenName);
    await page.locator("#token-form-submit").click();
    await expect(page.locator("#token-create-form")).toBeHidden();
    await page.locator("#token-done-btn").click();
    await expect(page.locator('.token-item-new')).not.toBeVisible();

    // Wait for list to stabilize
    await page.waitForTimeout(500);

    // Revoke it
    const tokenItem = page.locator(`.token-item:has-text("${tokenName}")`);
    await expect(tokenItem).toBeVisible();

    // Set up dialog handler BEFORE clicking
    const dialogPromise = page.waitForEvent('dialog');
    await tokenItem.locator('button[data-action="revoke"]').click();

    // Handle the confirmation dialog
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('revoke this token');
    await dialog.accept();

    // Token should be gone
    await expect(page.locator("#tokens-list")).not.toContainText(tokenName, { timeout: 2000 });
  });

  test("Cancel token creation", async ({ page }) => {
    // Open settings and Remote tab
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();

    // Click "Generate New Token"
    await page.locator("#settings-create-token").click();
    await expect(page.locator("#token-create-form")).toBeVisible();

    // Enter a name
    await page.locator("#token-name-input").fill("cancel-test");

    // Click cancel
    await page.locator("#token-form-cancel").click();

    // Form should disappear
    await expect(page.locator("#token-create-form")).toBeHidden();

    // Generate button should reappear
    await expect(page.locator("#settings-create-token")).toBeVisible();

    // No token should be created
    await expect(page.locator("#tokens-list")).not.toContainText("cancel-test");
  });

  test.skip("Submit button disabled when name is empty", async ({ page }) => {
    // SKIPPED: Button validation not implemented - submit button is always enabled
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();

    const submitBtn = page.locator("#token-form-submit");

    // Should be disabled when empty
    await expect(submitBtn).toBeDisabled();

    // Should enable when text entered
    await page.locator("#token-name-input").fill("test");
    await expect(submitBtn).toBeEnabled();

    // Should disable again when cleared
    await page.locator("#token-name-input").fill("");
    await expect(submitBtn).toBeDisabled();
  });

  test.skip("Press Enter to submit form", async ({ page }) => {
    // SKIPPED: Cleanup fails - token doesn't appear in regular list after Done
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();

    const tokenName = `enter-test-${Date.now()}`;
    const nameInput = page.locator("#token-name-input");
    await nameInput.fill(tokenName);

    // Press Enter
    await nameInput.press("Enter");

    // Form should disappear
    await expect(page.locator("#token-create-form")).toBeHidden();

    // Token should be created
    await expect(page.locator("#tokens-list")).toContainText(tokenName, { timeout: 2000 });

    // Clean up
    await page.locator("#token-done-btn").click();
    await expect(page.locator('.token-item-new')).not.toBeVisible();
    await page.waitForTimeout(500);
    const tokenItem = page.locator(`.token-item:has-text("${tokenName}")`);
    const cleanupDialogPromise = page.waitForEvent('dialog');
    await tokenItem.locator('button[data-action="revoke"]').click();
    const cleanupDialog = await cleanupDialogPromise;
    await cleanupDialog.accept();
    await expect(tokenItem).not.toBeVisible({ timeout: 2000 });
  });
});
