import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto('http://localhost:3001');
  await page.waitForSelector('.xterm');
  await page.waitForTimeout(2000);

  // Check if the element exists in the DOM
  const check = await page.evaluate(() => {
    const settingsViews = document.getElementById('settings-views');
    const mainView = document.getElementById('settings-view-main');

    return {
      settingsViewsExists: !!settingsViews,
      settingsViewsHTML: settingsViews ? settingsViews.innerHTML.substring(0, 500) : 'NOT FOUND',
      mainViewExists: !!mainView,
      mainViewHTML: mainView ? mainView.innerHTML.substring(0, 200) : 'NOT FOUND',
      childrenCount: settingsViews ? settingsViews.children.length : 0,
      childrenList: settingsViews ? Array.from(settingsViews.children).map(c => ({
        id: c.id,
        className: c.className
      })) : []
    };
  });

  console.log(JSON.stringify(check, null, 2));

  await browser.close();
})();
