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

  console.log('📸 Starting screenshot session...');
  console.log(`📁 Output directory: ${OUTPUT_DIR}`);

  try {
    // Navigate to Katulong
    console.log(`🌐 Opening ${KATULONG_URL}...`);
    await page.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000); // Let terminal fully load

    // 1. Terminal Interface (main view with shortcuts)
    console.log('📸 1/7: Terminal interface...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'terminal-main.png'),
      fullPage: false
    });

    // 2. Settings Panel
    console.log('📸 2/7: Settings panel...');
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-overlay.visible', { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: join(OUTPUT_DIR, 'settings.png'),
      fullPage: false
    });

    // 3. LAN Pairing Flow
    console.log('📸 3/7: LAN pairing...');
    const pairBtn = await page.$('#settings-pair');
    if (pairBtn) {
      await pairBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: join(OUTPUT_DIR, 'pairing-flow.png'),
        fullPage: false
      });

      // Back to main settings
      const backBtn = await page.$('#wizard-back-trust, #wizard-back-pair');
      if (backBtn) {
        await backBtn.click();
        await page.waitForTimeout(500);
      }
    } else {
      console.log('⚠️  Pair button not found, skipping pairing screenshot');
    }

    // 4. Devices tab
    console.log('📸 4/7: Device management...');
    const devicesTab = await page.$('#tab-devices');
    if (devicesTab) {
      await devicesTab.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: join(OUTPUT_DIR, 'devices.png'),
        fullPage: false
      });
    } else {
      console.log('⚠️  Devices tab not found');
    }

    // Close settings
    await page.click('#settings-overlay', { position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    // 5. Shortcuts Editor
    console.log('📸 5/7: Shortcuts editor...');
    try {
      await page.click('button[aria-label="Open shortcuts"]');
      await page.waitForSelector('#shortcuts-overlay.visible', { timeout: 5000 });
      await page.waitForTimeout(500);
      await page.click('#shortcuts-edit-btn');
      await page.waitForSelector('#edit-overlay.visible', { timeout: 5000 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: join(OUTPUT_DIR, 'shortcuts-editor.png'),
        fullPage: false
      });

      // Close shortcuts
      await page.click('#edit-overlay', { position: { x: 10, y: 10 } });
      await page.waitForTimeout(300);
      await page.click('#shortcuts-overlay', { position: { x: 10, y: 10 } });
      await page.waitForTimeout(500);
    } catch (e) {
      console.log('⚠️  Could not open shortcuts:', e.message);
    }

    // 6. Sessions view
    console.log('📸 6/7: Sessions view...');
    try {
      await page.click('#sessions-btn');
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: join(OUTPUT_DIR, 'sessions.png'),
        fullPage: false
      });
    } catch (e) {
      console.log('⚠️  Sessions view not available');
    }

    // 7. Mobile View
    console.log('📸 7/7: Mobile view...');
    await context.close();
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 }, // iPhone 14 Pro
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await mobilePage.waitForTimeout(2000);
    await mobilePage.screenshot({
      path: join(OUTPUT_DIR, 'terminal-mobile.png'),
      fullPage: false
    });

    await mobileContext.close();

    console.log('\n✅ All screenshots captured successfully!');
    console.log(`📁 Saved to: ${OUTPUT_DIR}`);
    console.log('\nScreenshots created:');
    console.log('  - terminal-main.png');
    console.log('  - settings.png');
    console.log('  - pairing-flow.png');
    console.log('  - devices.png');
    console.log('  - shortcuts-editor.png');
    console.log('  - sessions.png');
    console.log('  - terminal-mobile.png');

  } catch (error) {
    console.error('❌ Error taking screenshots:', error);
  } finally {
    await browser.close();
  }
}

takeScreenshots().catch(console.error);
