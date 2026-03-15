import { test, expect } from "@playwright/test";
import { setupTest, cleanupSession, openSettings, switchSettingsTab } from './helpers.js';

test.describe("Setup Tokens", () => {
  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = await setupTest({ page, context, testInfo });
  });

  test.afterEach(async ({ page }) => {
    await cleanupSession(page, sessionName);
  });

  test("Create token - should appear in list immediately", async ({ page }) => {
    const settingsBtn = page.locator('#key-island .key-island-btn[aria-label="Settings"]');
    await settingsBtn.click();
    await expect(page.locator("#settings-overlay")).toHaveClass(/visible/);

    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.waitForSelector('#settings-tab-remote', { state: 'visible' });

    await page.locator("#settings-create-token").click();

    await expect(page.locator("#token-create-form")).toBeVisible();

    const tokenName = `test-token-${Date.now()}`;
    await page.locator("#token-name-input").fill(tokenName);

    await page.locator("#token-form-submit").click();

    await expect(page.locator("#token-create-form")).toBeHidden();

    const tokensList = page.locator("#tokens-list");
    await expect(tokensList).toContainText(tokenName, { timeout: 2000 });

    const newTokenItem = page.locator(".token-item-new");
    await expect(newTokenItem).toBeVisible();
    await expect(newTokenItem).toContainText(tokenName);
    await expect(newTokenItem).toContainText("Save this token now");

    const tokenValueField = newTokenItem.locator(".token-value-field");
    await expect(tokenValueField).toBeVisible();
    const tokenValue = await tokenValueField.inputValue();
    expect(tokenValue).toMatch(/^[a-f0-9]{32}$/);

    const copyBtn = newTokenItem.locator(".token-copy-btn");
    await copyBtn.click();
    await expect(copyBtn).toContainText("Copied!");
    await expect(copyBtn).toContainText("Copy", { timeout: 3000 });
  });

  test("Cancel token creation", async ({ page }) => {
    await page.locator('#key-island .key-island-btn[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();

    await page.locator("#settings-create-token").click();
    await expect(page.locator("#token-create-form")).toBeVisible();

    await page.locator("#token-name-input").fill("cancel-test");

    await page.locator("#token-form-cancel").click();

    await expect(page.locator("#token-create-form")).toBeHidden();

    await expect(page.locator("#settings-create-token")).toBeVisible();

    await expect(page.locator("#tokens-list")).not.toContainText("cancel-test");
  });

  test("Press Enter to submit form", async ({ page }) => {
    await page.locator('#key-island .key-island-btn[aria-label="Settings"]').click();
    await page.locator('.settings-tab[data-tab="remote"]').click();
    await page.locator("#settings-create-token").click();

    const tokenName = `enter-test-${Date.now()}`;
    const nameInput = page.locator("#token-name-input");
    await nameInput.fill(tokenName);

    await nameInput.press("Enter");

    await expect(page.locator("#token-create-form")).toBeHidden();

    const newTokenDisplay = page.locator('.token-item-new');
    await expect(newTokenDisplay).toBeVisible();
    await expect(newTokenDisplay).toContainText(tokenName);
  });
});
