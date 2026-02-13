import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:3001');
  await page.waitForSelector('.xterm');
  await page.waitForTimeout(2000);

  // Open settings modal
  await page.locator('#shortcut-bar button[aria-label="Settings"]').click();
  await page.waitForTimeout(500);

  // Inspect the settings view structure
  const inspection = await page.evaluate(() => {
    const mainView = document.getElementById('settings-view-main');

    if (!mainView) return { error: 'settings-view-main not found' };

    const getElementInfo = (el) => {
      if (!el) return null;
      const computed = window.getComputedStyle(el);
      return {
        id: el.id,
        className: el.className,
        innerHTML: el.innerHTML.substring(0, 200),
        childrenCount: el.children.length,
        display: computed.display,
        visibility: computed.visibility,
        opacity: computed.opacity,
        height: computed.height,
        overflow: computed.overflow
      };
    };

    // Get all tab content divs
    const tabContents = Array.from(mainView.querySelectorAll('.settings-tab-content'));

    return {
      mainView: getElementInfo(mainView),
      tabContents: tabContents.map(tc => getElementInfo(tc)),
      tabContentCount: tabContents.length,
      allChildren: Array.from(mainView.children).map(child => ({
        tagName: child.tagName,
        id: child.id,
        className: child.className,
        display: window.getComputedStyle(child).display
      }))
    };
  });

  console.log(JSON.stringify(inspection, null, 2));

  // Now click the Theme tab and check again
  console.log('\n=== After clicking Theme tab ===\n');
  await page.locator('.settings-tab[data-tab="theme"]').click();
  await page.waitForTimeout(300);

  const afterThemeClick = await page.evaluate(() => {
    const themeContent = document.getElementById('settings-tab-theme');
    const lanContent = document.getElementById('settings-tab-lan');
    const remoteContent = document.getElementById('settings-tab-remote');

    const getInfo = (el) => {
      if (!el) return null;
      const computed = window.getComputedStyle(el);
      return {
        exists: true,
        hasActiveClass: el.classList.contains('active'),
        display: computed.display,
        innerHTML: el.innerHTML.substring(0, 300)
      };
    };

    return {
      theme: getInfo(themeContent),
      lan: getInfo(lanContent),
      remote: getInfo(remoteContent)
    };
  });

  console.log(JSON.stringify(afterThemeClick, null, 2));

  await browser.close();
})();
