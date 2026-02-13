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
  console.log('📸 Katulong Screenshot Tool');
  console.log(`📁 Output: ${OUTPUT_DIR}\n`);

  const browser = await chromium.launch({
    headless: false, // Keep visible so you can interact
    slowMo: 500 // Slow down for visibility
  });

  try {
    // Desktop view
    const desktop = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2
    });
    const page = await desktop.newPage();

    console.log('🌐 Opening Katulong...');
    await page.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // 1. Main terminal
    console.log('📸 Terminal interface...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'terminal-main.png')
    });

    console.log('\n⏸️  PAUSED - Please manually:');
    console.log('   1. Click Settings gear icon');
    console.log('   2. Press ENTER when ready for screenshot');
    await page.pause();

    console.log('📸 Settings panel...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'settings.png')
    });

    console.log('\n⏸️  PAUSED - Please manually:');
    console.log('   1. Click "Pair New Device" or navigate to pairing');
    console.log('   2. Press ENTER when ready for screenshot');
    await page.pause();

    console.log('📸 Pairing flow...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'pairing-flow.png')
    });

    console.log('\n⏸️  PAUSED - Please manually:');
    console.log('   1. Go back and click Devices tab (if available)');
    console.log('   2. Press ENTER when ready for screenshot, or CTRL+C to skip');
    try {
      await page.pause();
      console.log('📸 Devices...');
      await page.screenshot({
        path: join(OUTPUT_DIR, 'devices.png')
      });
    } catch (e) {
      console.log('Skipped devices screenshot');
    }

    console.log('\n⏸️  PAUSED - Please manually:');
    console.log('   1. Close settings and open Shortcuts editor');
    console.log('   2. Click Edit button');
    console.log('   3. Press ENTER when ready for screenshot');
    await page.pause();

    console.log('📸 Shortcuts editor...');
    await page.screenshot({
      path: join(OUTPUT_DIR, 'shortcuts-editor.png')
    });

    await desktop.close();

    // Mobile view
    console.log('\n📱 Switching to mobile view...');
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(KATULONG_URL, { waitUntil: 'networkidle' });
    await mobilePage.waitForTimeout(3000);

    console.log('📸 Mobile terminal...');
    await mobilePage.screenshot({
      path: join(OUTPUT_DIR, 'terminal-mobile.png')
    });

    await mobile.close();

    console.log('\n✅ Screenshots complete!');
    console.log(`📁 Saved to: ${OUTPUT_DIR}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

takeScreenshots().catch(console.error);
