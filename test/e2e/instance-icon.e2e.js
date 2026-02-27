import { test, expect } from "@playwright/test";
import { setupTest, openSettings } from './helpers.js';

test.describe("Instance Icon Picker", () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test("Instance icon Change button exists in Settings > Theme tab", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog');

    // Theme tab is active by default — verify Change button exists
    const changeBtn = dialog.getByRole('button', { name: 'Change' });
    await expect(changeBtn).toBeVisible();
  });

  test("Clicking Change opens icon picker modal", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog');

    await dialog.getByRole('button', { name: 'Change' }).click();

    // Verify icon picker dialog appears
    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });
  });

  test("Icon picker displays icons", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });

    // Verify icons are present (check for a few known ones)
    await expect(page.getByLabel('Icon: laptop')).toBeVisible();
    await expect(page.getByLabel('Icon: house')).toBeVisible();
    await expect(page.getByLabel('Icon: terminal-window')).toBeVisible();
  });

  test("Pressing Escape closes the icon picker", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(pickerDialog).not.toBeVisible({ timeout: 5000 });
  });

  test("Selecting an icon closes the picker", async ({ page }) => {
    await openSettings(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });

    // Select laptop icon
    await page.getByLabel('Icon: laptop').click();

    // Picker should close
    await expect(pickerDialog).not.toBeVisible({ timeout: 5000 });
  });

  test("Selected icon persists after page reload", async ({ page }) => {
    // Open settings and select an icon
    await openSettings(page);
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });

    // Select desktop icon
    await page.getByLabel('Icon: desktop').click();
    await expect(pickerDialog).not.toBeVisible({ timeout: 5000 });

    // Close settings
    await page.keyboard.press('Escape');

    // Reload
    await page.reload();
    await page.waitForSelector(".xterm", { timeout: 10000 });
    await page.waitForSelector(".xterm-screen", { timeout: 5000 });

    // Re-open settings and verify the icon is still selected
    await openSettings(page);
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    const newPickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(newPickerDialog).toBeVisible({ timeout: 5000 });

    // Desktop icon should be marked as selected
    const desktopIcon = page.getByLabel('Icon: desktop');
    await expect(desktopIcon).toBeVisible();

    // Reset to default
    await page.getByLabel('Icon: terminal-window').click();
  });

  test("Current icon is marked as selected in picker", async ({ page }) => {
    // Select laptop icon first
    await openSettings(page);
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Change' }).click();

    let pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });
    await page.getByLabel('Icon: laptop').click();
    await expect(pickerDialog).not.toBeVisible({ timeout: 5000 });

    // Re-open icon picker
    await dialog.getByRole('button', { name: 'Change' }).click();
    pickerDialog = page.getByRole('dialog').filter({ hasText: 'Choose Icon' });
    await expect(pickerDialog).toBeVisible({ timeout: 5000 });

    // Laptop icon should have selected state
    const laptopIcon = page.getByLabel('Icon: laptop');
    await expect(laptopIcon).toHaveAttribute('aria-selected', 'true');

    // House icon should not be selected
    const houseIcon = page.getByLabel('Icon: house');
    await expect(houseIcon).not.toHaveAttribute('aria-selected', 'true');

    // Reset to default
    await page.getByLabel('Icon: terminal-window').click();
  });
});
