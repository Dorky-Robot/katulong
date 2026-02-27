import { test, expect } from "@playwright/test";
import { setupTest } from './helpers.js';

test.describe("Shortcuts popup", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test("Clicking keyboard icon opens the shortcuts popup", async ({ page }) => {
    const kbBtn = page.getByRole('button', { name: 'Open shortcuts' });
    await kbBtn.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(dialog).toBeVisible({ timeout: 5000 });
  });

  test("Edit button is present in the popup", async ({ page }) => {
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const editBtn = dialog.getByRole('button', { name: 'Edit shortcuts' });
    await expect(editBtn).toBeVisible();
  });

  test("Closing the modal returns focus to terminal", async ({ page }) => {
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Close via Escape
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // Terminal textarea should have focus
    const focused = page.locator(".xterm-helper-textarea");
    await expect(focused).toBeFocused();
  });

  test("Add shortcut flow creates a new shortcut", async ({ page }) => {
    // Open shortcuts popup
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const shortcutsDialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(shortcutsDialog).toBeVisible({ timeout: 5000 });

    // Click edit
    await shortcutsDialog.getByRole('button', { name: 'Edit shortcuts' }).click();
    await expect(shortcutsDialog).not.toBeVisible({ timeout: 5000 });

    const editDialog = page.getByRole('dialog').filter({ hasText: 'Edit Shortcuts' });
    await expect(editDialog).toBeVisible({ timeout: 5000 });

    // Click add
    await editDialog.getByRole('button', { name: 'Add' }).click();
    await expect(editDialog).not.toBeVisible({ timeout: 5000 });

    const addDialog = page.getByRole('dialog').filter({ hasText: 'Add Shortcut' });
    await expect(addDialog).toBeVisible({ timeout: 5000 });

    // Fill in label and keys
    await addDialog.getByRole('textbox', { name: 'Label' }).fill('Clear Screen');
    await addDialog.getByRole('textbox', { name: 'Keys' }).fill('ctrl+l');

    // Save
    await addDialog.getByRole('button', { name: 'Add' }).click();
    await expect(addDialog).not.toBeVisible({ timeout: 5000 });

    // Reopen shortcuts popup and verify the new shortcut appears
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const newDialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(newDialog).toBeVisible({ timeout: 5000 });
    await expect(newDialog.getByText('Clear Screen')).toBeVisible();
  });

  test("Added shortcut appears in edit list", async ({ page }) => {
    // Open shortcuts → Edit → Add
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const shortcutsDialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(shortcutsDialog).toBeVisible({ timeout: 5000 });

    await shortcutsDialog.getByRole('button', { name: 'Edit shortcuts' }).click();
    const editDialog = page.getByRole('dialog').filter({ hasText: 'Edit Shortcuts' });
    await expect(editDialog).toBeVisible({ timeout: 5000 });

    await editDialog.getByRole('button', { name: 'Add' }).click();
    const addDialog = page.getByRole('dialog').filter({ hasText: 'Add Shortcut' });
    await expect(addDialog).toBeVisible({ timeout: 5000 });

    // Fill in and save
    await addDialog.getByRole('textbox', { name: 'Label' }).fill('Send EOF');
    await addDialog.getByRole('textbox', { name: 'Keys' }).fill('ctrl+d');
    await addDialog.getByRole('button', { name: 'Add' }).click();
    await expect(addDialog).not.toBeVisible({ timeout: 5000 });

    // Should be back in edit dialog with the new shortcut listed
    // Re-open edit to verify
    await page.getByRole('button', { name: 'Open shortcuts' }).click();
    const newShortcutsDialog = page.getByRole('dialog').filter({ hasText: 'Shortcuts' });
    await expect(newShortcutsDialog).toBeVisible({ timeout: 5000 });
    await expect(newShortcutsDialog.getByText('Send EOF')).toBeVisible();
  });
});

test.describe("Dictation modal", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test("Dictation dialog has text input and send button", async ({ page }) => {
    // Open dictation via context menu on terminal
    const terminal = page.locator(".xterm");
    await terminal.dispatchEvent("contextmenu");

    const dialog = page.getByRole('dialog').filter({ hasText: 'Dictation' });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Verify text input and send button exist
    await expect(dialog.getByRole('textbox')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});
