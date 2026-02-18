import { defineConfig, devices } from "@playwright/test";

const PORT = 3099;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.e2e.js",
  fullyParallel: true, // Distribute individual tests across workers, not just files
  workers: "100%", // Use all CPU cores instead of default 50%
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
    // start-test-server.sh creates fixture auth state BEFORE server starts and caches it
    command: `bash test/e2e/start-test-server.sh`,
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
