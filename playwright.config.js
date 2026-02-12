import { defineConfig, devices } from "@playwright/test";

const PORT = 3099;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.e2e.js",
  timeout: 30_000,
  retries: 2, // Retry flaky tests to handle resource contention
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `KATULONG_NO_AUTH=1 PORT=${PORT} KATULONG_SOCK=/tmp/katulong-test.sock node entrypoint.js`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 14"],
        browserName: "chromium",
      },
    },
  ],
});
