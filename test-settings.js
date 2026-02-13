import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Capture all console messages
  const consoleLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    if (text.includes('Modal') || text.includes('settings')) {
      console.log(`  → ${text}`);
    }
  });

  // Capture errors
  page.on('pageerror', err => console.log(`ERROR: ${err.message}`));

  await page.goto('http://localhost:3001');
  await page.waitForSelector('.xterm', { timeout: 10000 });
  await page.waitForTimeout(2000); // Let everything initialize

  console.log('\n=== Testing Settings Modal ===\n');

  // Check initial state
  const initial = await page.evaluate(() => {
    const overlay = document.getElementById('settings-overlay');
    const buttons = Array.from(document.querySelectorAll('#shortcut-bar button'));
    return {
      overlayExists: !!overlay,
      overlayVisible: overlay?.classList.contains('visible'),
      numButtons: buttons.length,
      lastButtonLabel: buttons[buttons.length - 1]?.getAttribute('aria-label'),
      lastButtonHTML: buttons[buttons.length - 1]?.innerHTML
    };
  });
  console.log('Initial state:', JSON.stringify(initial, null, 2));

  // Try to click the settings button
  console.log('\nClicking settings button...');
  const settingsBtn = page.locator('#shortcut-bar button[aria-label="Settings"]');
  await settingsBtn.click();
  await page.waitForTimeout(500);

  // Check state after click
  const afterClick = await page.evaluate(() => {
    const overlay = document.getElementById('settings-overlay');
    const computed = overlay ? window.getComputedStyle(overlay) : null;
    return {
      overlayVisible: overlay?.classList.contains('visible'),
      allClasses: overlay?.className,
      display: computed?.display,
      opacity: computed?.opacity,
      visibility: computed?.visibility
    };
  });
  console.log('\nAfter click:', JSON.stringify(afterClick, null, 2));

  // Try opening it manually
  console.log('\nTrying manual open...');
  const manualOpen = await page.evaluate(() => {
    const overlay = document.getElementById('settings-overlay');
    overlay.classList.add('visible');
    const computed = window.getComputedStyle(overlay);
    return {
      hasVisibleClass: overlay.classList.contains('visible'),
      display: computed.display,
      opacity: computed.opacity
    };
  });
  console.log('Manual open result:', JSON.stringify(manualOpen, null, 2));

  await page.screenshot({ path: '/tmp/settings-test.png' });
  console.log('\n✓ Screenshot: /tmp/settings-test.png');

  await browser.close();
  console.log('\n=== Test Complete ===\n');
})();
