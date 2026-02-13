import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:3001');
  await page.waitForSelector('.xterm');
  await page.waitForTimeout(2000);

  // Click settings button
  await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
  await page.waitForTimeout(500);

  // Inspect the modal structure
  const inspection = await page.evaluate(() => {
    const overlay = document.getElementById('settings-overlay');
    const panel = document.getElementById('settings-panel');
    const views = document.getElementById('settings-views');
    const mainView = document.getElementById('settings-view-main');

    const getStyles = (el) => {
      if (!el) return null;
      const computed = window.getComputedStyle(el);
      return {
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity,
        width: computed.width,
        height: computed.height,
        position: computed.position,
        zIndex: computed.zIndex
      };
    };

    return {
      overlay: { exists: !!overlay, styles: getStyles(overlay), classes: overlay?.className },
      panel: { exists: !!panel, styles: getStyles(panel), classes: panel?.className },
      views: { exists: !!views, styles: getStyles(views), classes: views?.className },
      mainView: { exists: !!mainView, styles: getStyles(mainView), classes: mainView?.className }
    };
  });

  console.log(JSON.stringify(inspection, null, 2));

  await browser.close();
})();
