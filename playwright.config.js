import { defineConfig, devices } from "@playwright/test";
import { TEST_PORT, SHARD_INDEX, BASE_URL } from "./test/e2e/test-config.js";

const workers = process.env.PW_WORKERS
  ? parseInt(process.env.PW_WORKERS, 10)
  : "100%";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.e2e.js",
  fullyParallel: true, // Distribute individual tests across workers, not just files
  workers,
  timeout: 30_000,
  retries: 2, // Retry flaky tests to handle resource contention
  globalSetup: "./test/e2e/global-setup.js",
  globalTeardown: "./test/e2e/global-teardown.js",
  reporter: SHARD_INDEX > 0
    ? [["blob"], ["list"]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: {
    // IMPORTANT: Test server uses isolated data directory per shard
    // This ensures dev database remains clean and test data is wiped between runs
    // start-test-server.sh creates fixture auth state BEFORE server starts and caches it
    command: `bash test/e2e/start-test-server.sh`,
    port: TEST_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    env: { TEST_SHARD_INDEX: String(SHARD_INDEX) },
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
