import { test, expect } from "@playwright/test";

test.describe("Setup Tokens", () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("http://localhost:3001");
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForTimeout(1000);
  });

  test("Create token - should appear in list immediately", async ({ page }) => {
    // Open settings modal
    const settingsBtn = page.locator('#shortcut-bar button[aria-label="Settings"]');
    await settingsBtn.click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    // Switch to Remote tab
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.waitForTimeout(200);

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
    await page.waitForTimeout(2500);
    await expect(copyBtn).toContainText("Copy");

    // Click "Done" button
    await page.locator("#token-done-btn").click();

    // New token display should disappear
    await expect(newTokenItem).toBeHidden();

    // Token should now appear in regular list (not as "new")
    await expect(tokensList).toContainText(tokenName);
    const regularTokenItem = page.locator(`.token-item:not(.token-item-new):has-text("${tokenName}")`);
    await expect(regularTokenItem).toBeVisible();
    await expect(regularTokenItem).toContainText("Unused");

    // Clean up - revoke the token
    await regularTokenItem.locator('button[data-action="revoke"]').click();
    page.on('dialog', dialog => dialog.accept());
    await page.waitForTimeout(500);
  });

  test("Rename token", async ({ page }) => {
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
    await page.waitForTimeout(500);

    // Find the token and click rename
    const tokenItem = page.locator(`.token-item:has-text("${originalName}")`);
    await tokenItem.locator('button[data-action="rename"]').click();

    // Handle the prompt dialog
    const newName = `renamed-${Date.now()}`;
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept(newName);
    });

    // Wait for rename to complete
    await page.waitForTimeout(1000);

    // Should show new name
    await expect(page.locator("#tokens-list")).toContainText(newName);
    await expect(page.locator("#tokens-list")).not.toContainText(originalName);

    // Clean up
    const renamedItem = page.locator(`.token-item:has-text("${newName}")`);
    await renamedItem.locator('button[data-action="revoke"]').click();
    page.on('dialog', dialog => dialog.accept());
    await page.waitForTimeout(500);
  });

  test("Revoke unused token", async ({ page }) => {
    // Create a token
    await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();
    const tokenName = `revoke-test-${Date.now()}`;
    await page.locator("#token-name-input").fill(tokenName);
    await page.locator("#token-form-submit").click();
    await expect(page.locator("#token-create-form")).toBeHidden();
    await page.locator("#token-done-btn").click();
    await page.waitForTimeout(500);

    // Revoke it
    const tokenItem = page.locator(`.token-item:has-text("${tokenName}")`);
    await tokenItem.locator('button[data-action="revoke"]').click();

    // Should show confirmation
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('revoke this token');
      await dialog.accept();
    });

    // Wait for revocation
    await page.waitForTimeout(1000);

    // Token should be gone
    await expect(page.locator("#tokens-list")).not.toContainText(tokenName);
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

  test("Submit button disabled when name is empty", async ({ page }) => {
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

  test("Press Enter to submit form", async ({ page }) => {
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
    await page.waitForTimeout(500);
    const tokenItem = page.locator(`.token-item:has-text("${tokenName}")`);
    await tokenItem.locator('button[data-action="revoke"]').click();
    page.on('dialog', dialog => dialog.accept());
  });
});
