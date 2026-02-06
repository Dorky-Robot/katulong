import { test, expect } from "@playwright/test";

test.describe("Swipe zone", () => {
  test("Desktop: #swipe-zone is hidden (display: none)", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "Desktop-only test");
    await page.goto("/");
    await page.waitForSelector("#swipe-zone", { state: "attached" });

    const display = await page.locator("#swipe-zone").evaluate((el) =>
      getComputedStyle(el).display
    );
    expect(display).toBe("none");
  });

  test("Mobile: #swipe-zone is visible and positioned at left edge", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile-only test");
    await page.goto("/");
    await page.waitForSelector("#swipe-zone");

    const styles = await page.locator("#swipe-zone").evaluate((el) => {
      const s = getComputedStyle(el);
      return { display: s.display, left: s.left };
    });
    expect(styles.display).not.toBe("none");
    expect(parseInt(styles.left)).toBe(0);
  });

  test("Mobile: swipe zone is 44px wide", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "Mobile-only test");
    await page.goto("/");
    await page.waitForSelector("#swipe-zone");

    const width = await page.locator("#swipe-zone").evaluate((el) =>
      el.getBoundingClientRect().width
    );
    expect(width).toBe(44);
  });
});
