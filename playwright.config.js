import { defineConfig, devices } from "@playwright/test";

const PORT = 3099;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.e2e.js",
  timeout: 30_000,
  retries: 2, // Retry flaky tests to handle resource contention
  globalSetup: "./test/e2e/global-setup.js",
  globalTeardown: "./test/e2e/global-teardown.js",
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    // IMPORTANT: Test server uses isolated data directory (/tmp/katulong-e2e-data)
    // This ensures dev database remains clean and test data is wiped between runs
    command: `KATULONG_NO_AUTH=1 PORT=${PORT} KATULONG_SOCK=/tmp/katulong-test.sock KATULONG_DATA_DIR=/tmp/katulong-e2e-data node entrypoint.js`,
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
