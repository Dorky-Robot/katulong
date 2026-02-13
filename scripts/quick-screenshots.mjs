import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KATULONG_URL = 'http://localhost:3001';
const OUTPUT_DIR = join(__dirname, '../docs/assets/images');

mkdirSync(OUTPUT_DIR, { recursive: true });

async function quickScreenshots() {
  console.log('📸 Taking quick screenshots...\n');

  const browser = await chromium.launch({ headless: true });

  // Desktop terminal
  const desktop = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2
  });
  const page = await desktop.newPage();
  await page.goto(KATULONG_URL, { waitUntil: 'networkidle', timeout: 10000 });
  await page.waitForTimeout(3000);

  console.log('📸 Desktop terminal...');
  await page.screenshot({ path: join(OUTPUT_DIR, 'terminal-main.png') });

  await desktop.close();

  // Mobile terminal
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(KATULONG_URL, { waitUntil: 'networkidle', timeout: 10000 });
  await mobilePage.waitForTimeout(3000);

  console.log('📸 Mobile terminal...');
  await mobilePage.screenshot({ path: join(OUTPUT_DIR, 'terminal-mobile.png') });

  await browser.close();

  console.log(`\n✅ Done! Screenshots saved to:\n   ${OUTPUT_DIR}\n`);
  console.log('📝 Note: For other screenshots (settings, pairing, etc.),');
  console.log('   you can manually take them using your OS screenshot tool.');
}

quickScreenshots().catch(console.error);
