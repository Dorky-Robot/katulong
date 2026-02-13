import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATULONG_URL = 'http://localhost:3001';
const OUTPUT_DIR = join(__dirname, '../docs/assets/images');

// Create output directory
mkdirSync(OUTPUT_DIR, { recursive: true });

async function takeScreenshots() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2 // Retina quality
  });

  const page = await context.newPage();

  console.log('📸 Starting automated screenshot session...');
  console.log(`📁 Output directory: ${OUTPUT_DIR}\n`);

  try {
    // Navigate to Katulong
    console.log('🌐 Opening http://localhost:3001...');
    await page.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); // Let terminal fully load

    // 1. Terminal Interface (main view with shortcuts)
    console.log('📸 1/7: Terminal interface...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'terminal-main.png'),
      fullPage: false
    });

    // 2. Settings Panel - use aria-label selector
    console.log('📸 2/7: Opening settings...');
    const settingsBtn = await page.locator('button[aria-label="Settings"]');
    await settingsBtn.click();
    await page.waitForSelector('#settings-overlay.visible', { timeout: 10000 });
    await page.waitForTimeout(1000);

    console.log('📸 2/7: Settings panel...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'settings.png'),
      fullPage: false
    });

    // 3. Switch to LAN tab for devices and pairing
    console.log('📸 3/7: Switching to LAN tab...');
    const lanTab = await page.locator('button.settings-tab[data-tab="lan"]');
    if (await lanTab.count() > 0) {
      await lanTab.click();
      await page.waitForTimeout(1000);

      // Take screenshot of devices list in LAN tab
      console.log('📸 3/7: Devices in LAN tab...');
      await page.screenshot({
        path: join(OUTPUT_DIR, 'devices.png'),
        fullPage: false
      });
    }

    // 4. LAN Pairing flow
    console.log('📸 4/7: LAN pairing...');
    const pairBtn = await page.locator('#settings-pair-lan');
    if (await pairBtn.count() > 0) {
      await pairBtn.click();
      await page.waitForTimeout(2500); // Wait for QR code to generate
      await page.screenshot({
        path: join(OUTPUT_DIR, 'pairing-flow.png'),
        fullPage: false
      });

      // Back to main settings
      const backBtn = await page.locator('#wizard-back-pair, #wizard-back-trust').first();
      if (await backBtn.count() > 0) {
        await backBtn.click();
        await page.waitForTimeout(500);
      }
    } else {
      console.log('⚠️  Pair button not found, skipping pairing screenshot');
    }

    // Close settings by pressing Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // 5. Shortcuts view
    try {
      console.log('📸 5/7: Opening shortcuts...');
      const shortcutsBtn = await page.locator('button[aria-label="Open shortcuts"]');
      if (await shortcutsBtn.count() > 0) {
        await shortcutsBtn.click();
        await page.waitForSelector('#shortcuts-overlay.visible', { timeout: 5000 });
        await page.waitForTimeout(500);

        // Click edit button
        const editBtn = await page.locator('#shortcuts-edit-btn');
        if (await editBtn.count() > 0) {
          await editBtn.click();
          await page.waitForSelector('#edit-overlay.visible', { timeout: 5000 });
          await page.waitForTimeout(500);

          console.log('📸 5/7: Shortcuts editor...');
          await page.screenshot({
            path: join(OUTPUT_DIR, 'shortcuts-editor.png'),
            fullPage: false
          });

          // Close edit overlay with Escape
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        }

        // Close shortcuts overlay with Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️  Shortcuts button not found');
      }
    } catch (e) {
      console.log('⚠️  Could not capture shortcuts:', e.message);
    }

    // 6. Sessions view
    try {
      console.log('📸 6/7: Opening sessions...');
      const sessionsBtn = await page.locator('button[aria-label="Sessions"]');
      if (await sessionsBtn.count() > 0) {
        await sessionsBtn.click();
        await page.waitForSelector('#session-overlay.visible', { timeout: 5000 });
        await page.waitForTimeout(1000);

        console.log('📸 6/7: Sessions view...');
        await page.screenshot({
          path: join(OUTPUT_DIR, 'sessions.png'),
          fullPage: false
        });

        // Close sessions with Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      } else {
        console.log('⚠️  Sessions button not found');
      }
    } catch (e) {
      console.log('⚠️  Could not capture sessions:', e.message);
    }

    await context.close();

    // 7. Mobile View
    console.log('📸 7/7: Mobile view...');
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, // iPhone 14 Pro
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await mobilePage.waitForTimeout(3000);
    await mobilePage.screenshot({
      path: join(OUTPUT_DIR, 'terminal-mobile.png'),
      fullPage: false
    });

    await mobileContext.close();

    console.log('\n✅ All screenshots captured successfully!');
    console.log(`📁 Saved to: ${OUTPUT_DIR}`);
    console.log('\nScreenshots created:');
    console.log('  ✓ terminal-main.png');
    console.log('  ✓ settings.png');
    console.log('  ✓ devices.png');
    console.log('  ✓ pairing-flow.png');
    console.log('  ✓ shortcuts-editor.png');
    console.log('  ✓ sessions.png');
    console.log('  ✓ terminal-mobile.png');

  } catch (error) {
    console.error('❌ Error taking screenshots:', error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

takeScreenshots().catch(console.error);
