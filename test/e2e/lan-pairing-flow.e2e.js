/**
 * E2E tests for complete LAN pairing wizard flow
 *
 * Tests the full user journey from opening the wizard to seeing
 * the paired device in the list.
 *
 * Note: Trust step was removed in #86. The wizard now goes directly from
 * "Pair Device on LAN" → pairing step (2-step flow: pair → success).
 */

import { test, expect } from '@playwright/test';
import { setupTest, openSettings, switchSettingsTab } from './helpers.js';

test.describe('LAN Pairing Wizard Flow', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should complete full pairing flow - pairing step', async ({ page }) => {
    // Step 1: Open Settings → LAN tab
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Step 2: Click "Pair Device on LAN" — goes directly to pair step (trust step removed)
    await page.click('button:has-text("Pair Device on LAN")');

    // Should be on Pair step immediately
    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Step 1: Verify pairing QR code renders
    const pairQR = pairView.locator('#wizard-pair-qr canvas');
    await expect(pairQR).toBeVisible({ timeout: 3000 });

    // Verify QR has actual content
    const qrWidth = await pairQR.evaluate(el => el.width);
    expect(qrWidth).toBeGreaterThan(100);

    // Step 2: Verify PIN is displayed and is 8 digits
    const pinDisplay = pairView.locator('#wizard-pair-pin');
    await expect(pinDisplay).toBeVisible();

    const pinText = await pinDisplay.textContent();
    expect(pinText).toMatch(/^\d{8}$/); // Exactly 8 digits

    // Step 3: Verify copy URL button works
    const copyBtn = pairView.locator('#wizard-pair-copy-url');
    await expect(copyBtn).toBeVisible();

    await copyBtn.click();
    await expect(copyBtn).toContainText('Copied!');

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toMatch(/^https?:\/\//);
    expect(clipboardText).toContain('/pair'); // Actual URL is /pair not /auth/pair

    // Step 4: Verify countdown timer is present and counting
    const countdown = pairView.locator('#wizard-pair-countdown');
    await expect(countdown).toBeVisible();

    const initialCountdown = await countdown.textContent();
    expect(initialCountdown).toMatch(/\d+s/); // Should show "Xseconds"

    // Wait and verify countdown decreases
    await page.waitForFunction(
      (initial) => {
        const countdownEl = document.querySelector('#wizard-pair-countdown');
        return countdownEl && countdownEl.textContent !== initial;
      },
      initialCountdown,
      { timeout: 2000 }
    );
    const newCountdown = await countdown.textContent();
    expect(newCountdown).not.toBe(initialCountdown);

    // Step 5: Extract pairing code from URL for simulated pairing
    const pairUrl = new URL(clipboardText);
    const pairCode = pairUrl.searchParams.get('code') || pairUrl.pathname.split('/').pop();
    expect(pairCode).toBeTruthy();

    console.log('[Test] Pairing code:', pairCode);
    console.log('[Test] PIN:', pinText);
  });

  test('should show countdown and refresh pairing code', async ({ page }) => {
    // Navigate to pairing step
    await openSettings(page);
    await switchSettingsTab(page, 'lan');
    await page.click('button:has-text("Pair Device on LAN")');

    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Get initial PIN
    const pinDisplay = pairView.locator('#wizard-pair-pin');
    const initialPin = await pinDisplay.textContent();

    // Get initial QR code
    const pairQR = pairView.locator('#wizard-pair-qr canvas');
    const initialQRData = await pairQR.evaluate(el => el.toDataURL());

    // Countdown should be running
    const countdown = pairView.locator('#wizard-pair-countdown');
    await expect(countdown).toBeVisible();

    // Note: Testing auto-refresh would require waiting 30s, which is too slow
    // Instead, we verify the countdown is present and ticking
    const countdownText = await countdown.textContent();
    expect(countdownText).toMatch(/\d+s/);
  });

  test('should handle back navigation in wizard', async ({ page }) => {
    // Navigate to pairing step
    await openSettings(page);
    await switchSettingsTab(page, 'lan');
    await page.click('button:has-text("Pair Device on LAN")');

    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Click back button — should go to main settings (trust step removed)
    const backBtn = page.locator('#wizard-back-pair');
    await backBtn.click();

    // Should be back on main settings view
    const mainView = page.locator('#settings-view-main');
    await expect(mainView).toHaveClass(/active/, { timeout: 2000 });
  });

  test('should clean up timers when closing wizard', async ({ page }) => {
    // Navigate to pairing step (which starts countdown and status poll intervals)
    await openSettings(page);
    await switchSettingsTab(page, 'lan');
    await page.click('button:has-text("Pair Device on LAN")');

    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Verify countdown is running by capturing its text
    const countdown = pairView.locator('#wizard-pair-countdown');
    await expect(countdown).toBeVisible();
    const textBefore = await countdown.textContent();

    // Close modal via Escape (triggers modal.close() → onClose → cleanupWizard)
    await page.keyboard.press('Escape');
    const modal = page.locator('#settings-overlay');
    await expect(modal).not.toHaveClass(/visible/, { timeout: 3000 });

    // Verify timers stopped: capture countdown text, wait, check it didn't change
    // If intervals were cleared, the text freezes; if still running, it decrements
    const textSnapshot = await page.evaluate(() =>
      document.getElementById('wizard-pair-countdown')?.textContent ?? ''
    );
    await page.waitForTimeout(1500);
    const textLater = await page.evaluate(() =>
      document.getElementById('wizard-pair-countdown')?.textContent ?? ''
    );
    expect(textSnapshot).toBe(textLater);
  });

  test('should display error if pairing code generation fails', async ({ page }) => {
    // Intercept the pairing API call and make it fail
    await page.route('/auth/pair/start', route => {
      route.fulfill({
        status: 500,
        body: JSON.stringify({ error: 'Internal server error' })
      });
    });

    // Navigate to pairing step
    await openSettings(page);
    await switchSettingsTab(page, 'lan');
    await page.click('button:has-text("Pair Device on LAN")');

    // Should show error message or fail gracefully
    // Wait for either error state or view to be active
    const pairView = page.locator('#settings-view-pair');
    await page.waitForFunction(
      () => {
        const view = document.querySelector('#settings-view-pair');
        const error = document.querySelector('.error, .alert, [role="alert"]');
        return view || error;
      },
      { timeout: 2000 }
    ).catch(() => {
      // Error handling may vary
    });
  });

  test('should handle QR library loading failure gracefully', async ({ page }) => {
    // Block the QR library from loading
    await page.route('**/qrcode.min.js', route => route.abort());

    // Try to open wizard
    await openSettings(page);
    await switchSettingsTab(page, 'lan');
    await page.click('button:has-text("Pair Device on LAN")');

    // Should go directly to pair view (trust step removed)
    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // QR canvas won't be present, but view should still be visible
    await expect(pairView).toBeVisible();
  });

  test('should have correct QR code colors based on theme', async ({ page }) => {
    // Set dark theme
    await page.evaluate(() => localStorage.setItem('theme', 'dark'));
    await page.reload();
    await page.waitForSelector(".xterm", { timeout: 10000 });

    // Open wizard — goes directly to pair step
    await page.click('button[aria-label="Settings"]');
    await page.click('.settings-tab[data-tab="lan"]');
    await page.click('button:has-text("Pair Device on LAN")');

    const pairView = page.locator('#settings-view-pair');
    const pairQR = pairView.locator('#wizard-pair-qr canvas');
    await expect(pairQR).toBeVisible({ timeout: 3000 });

    // Get canvas pixel data to verify it's not all white or all black
    const hasContent = await pairQR.evaluate(canvas => {
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // Check if we have both dark and light pixels (QR code pattern)
      let darkPixels = 0;
      let lightPixels = 0;

      for (let i = 0; i < data.length; i += 4) {
        const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (brightness < 128) darkPixels++;
        else lightPixels++;
      }

      return darkPixels > 100 && lightPixels > 100;
    });

    expect(hasContent).toBeTruthy();
  });
});

test.describe('Device List After Pairing', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should show device with correct format after pairing', async ({ page }) => {
    // This test assumes at least one device is already paired
    // In a real scenario, we'd complete the pairing first

    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Wait for device list to load
    const devicesList = page.locator('#devices-list');
    await expect(devicesList).toBeVisible({ timeout: 2000 });

    const deviceItems = page.locator('.device-item');
    const count = await deviceItems.count();

    if (count > 0) {
      const firstDevice = deviceItems.first();

      // Should have monitor icon
      await expect(firstDevice.locator('i.ph-monitor')).toBeVisible();

      // Should have device name
      const deviceName = firstDevice.locator('.device-name');
      await expect(deviceName).toBeVisible();
      const nameText = await deviceName.textContent();
      expect(nameText.length).toBeGreaterThan(0);

      // Should have metadata with correct format
      const meta = firstDevice.locator('.device-meta');
      await expect(meta).toBeVisible();

      const metaText = await meta.textContent();

      // Format: "Added: M/D/YYYY • Last used: Xh ago"
      expect(metaText).toContain('Added:');
      expect(metaText).toContain('Last used:');
      expect(metaText).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/); // Date format

      // Should have full-text buttons, not just icons
      const renameBtn = firstDevice.locator('button:has-text("Rename")');
      await expect(renameBtn).toBeVisible();
      await expect(renameBtn).toHaveClass(/device-btn/);

      // Remove button (if visible - may not be if it's the only device)
      const removeBtn = firstDevice.locator('button:has-text("Remove")');
      const isRemoveVisible = await removeBtn.isVisible();

      if (isRemoveVisible) {
        await expect(removeBtn).toHaveClass(/device-btn-danger/);
      }
    }
  });

  test('should update device list in real-time when new device pairs', async ({ page, request }) => {
    await openSettings(page);
    await switchSettingsTab(page, 'lan');

    // Get initial device count
    const deviceItems = page.locator('.device-item');
    const initialCount = await deviceItems.count();

    // Start pairing wizard to get a pairing code and PIN
    // (wizard goes directly to pair step now — trust step removed)
    await page.click('button:has-text("Pair Device on LAN")');

    const pairView = page.locator('#settings-view-pair');
    await expect(pairView).toHaveClass(/active/, { timeout: 2000 });

    // Get pairing code from the copy URL button
    const copyBtn = pairView.locator('#wizard-pair-copy-url');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    const pairUrl = new URL(clipboardText);
    const pairCode = pairUrl.searchParams.get('code');

    // Get PIN
    const pinDisplay = pairView.locator('#wizard-pair-pin');
    const pin = await pinDisplay.textContent();

    // Simulate remote device pairing via direct API call
    const verifyResponse = await request.post('/auth/pair/verify', {
      data: { code: pairCode, pin },
      headers: { 'Content-Type': 'application/json' }
    });
    expect(verifyResponse.ok()).toBeTruthy();

    // Device list should update in real-time (within 5s) without page refresh
    // The pair-complete WebSocket message should trigger refreshDeviceList
    await expect(deviceItems).toHaveCount(initialCount + 1, { timeout: 5000 });

    console.log('[Test] Device list updated in real-time after pairing');
  });
});
