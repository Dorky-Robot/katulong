import { test, expect } from "@playwright/test";

test.describe("Trust Page - Certificate Download", () => {
  test("should load the trust page", async ({ page }) => {
    await page.goto("/connect/trust");
    await expect(page.locator("h1")).toHaveText("Trust Certificate");
  });

  test("should show download button", async ({ page }) => {
    await page.goto("/connect/trust");

    const downloadBtn = page.locator("a.download-btn");
    await expect(downloadBtn).toBeVisible();
    await expect(downloadBtn).toHaveText("Download Certificate");
    await expect(downloadBtn).toHaveAttribute("href", "/connect/trust/ca.crt");
  });

  test("should serve ca.crt with correct content type", async ({ request }) => {
    const response = await request.get("/connect/trust/ca.crt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/x-x509-ca-cert");
    expect(response.headers()["content-disposition"]).toBe("attachment; filename=katulong-ca.crt");

    const body = await response.text();
    expect(body).toContain("BEGIN CERTIFICATE");
  });

  test("should show iOS profile link", async ({ page }) => {
    await page.goto("/connect/trust");

    const iosLink = page.locator('a[href="/connect/trust/ca.mobileconfig"]');
    await expect(iosLink).toBeVisible();
  });

  test("should show Android install steps", async ({ page }) => {
    await page.goto("/connect/trust");
    await expect(page.getByText("Install a certificate").first()).toBeVisible();
  });

  test("should show macOS install steps", async ({ page }) => {
    await page.goto("/connect/trust");
    await expect(page.getByText("Always Trust").first()).toBeVisible();
  });

  test("should have collapsible uninstall instructions", async ({ page }) => {
    await page.goto("/connect/trust");

    const details = page.locator("details");
    const summary = details.locator("summary");
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText("Uninstall instructions");

    // Expand
    await summary.click();
    await expect(details.locator("text=Remove Profile")).toBeVisible();
  });
});
