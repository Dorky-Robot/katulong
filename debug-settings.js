import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Listen for console messages
  page.on('console', msg => console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`));

  // Listen for page errors
  page.on('pageerror', err => console.log(`[Browser Error] ${err.message}`));

  // Navigate to the app
  await page.goto('http://localhost:3001');

  // Wait for terminal to be ready
  await page.waitForSelector('.xterm', { timeout: 10000 });
  console.log('✓ Terminal loaded');

  // Wait a bit for all initialization
  await page.waitForTimeout(2000);

  // Check if settings modal is registered
  const modalRegistered = await page.evaluate(() => {
    // Access the modals object from window or check if it exists
    const settingsOverlay = document.getElementById('settings-overlay');
    return {
      overlayExists: !!settingsOverlay,
      overlayClasses: settingsOverlay?.className,
      settingsButton: !!document.querySelector('[data-icon="settings"], .icon-settings, #settings-btn, button[title*="ettings"]')
    };
  });
  console.log('Modal check:', modalRegistered);

  // Find and click the settings button
  console.log('\nLooking for settings button...');

  // Try different selectors
  const settingsButton = await page.locator('#shortcut-bar button').last();

  console.log('Found settings button, clicking...');
  await settingsButton.click();

  // Wait a bit
  await page.waitForTimeout(1000);

  // Check modal state after click
  const afterClick = await page.evaluate(() => {
    const overlay = document.getElementById('settings-overlay');
    return {
      hasVisibleClass: overlay?.classList.contains('visible'),
      display: overlay ? window.getComputedStyle(overlay).display : 'N/A',
      opacity: overlay ? window.getComputedStyle(overlay).opacity : 'N/A',
      zIndex: overlay ? window.getComputedStyle(overlay).zIndex : 'N/A',
      innerHTML: overlay?.innerHTML.substring(0, 200)
    };
  });
  console.log('\nModal state after click:', afterClick);

  // Take screenshot
  await page.screenshot({ path: '/tmp/settings-modal-debug.png', fullPage: true });
  console.log('\n✓ Screenshot saved to /tmp/settings-modal-debug.png');

  // Keep browser open for inspection
  console.log('\nBrowser will stay open for 30 seconds...');
  await page.waitForTimeout(30000);

  await browser.close();
})();
