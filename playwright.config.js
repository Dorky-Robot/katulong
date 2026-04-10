import { defineConfig, devices } from "@playwright/test";
import { availableParallelism } from "os";
import { TEST_PORT, SHARD_INDEX, BASE_URL } from "./test/e2e/test-config.js";

// Cap default workers to avoid overwhelming tmux with concurrent session attach requests.
// With fullyParallel, all workers attach to the shared default session simultaneously.
// 4 workers is optimal: 0 flaky in 16s vs 8 workers with 4+ flaky in 19s+ (retries).
const workers = process.env.PW_WORKERS
  ? parseInt(process.env.PW_WORKERS, 10)
  : Math.min(4, availableParallelism());

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.e2e.js",
  fullyParallel: true, // Distribute individual tests across workers, not just files
  workers,
  timeout: 90_000,
  retries: process.env.CI ? 2 : 1,
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
    timeout: 60_000,
    env: { TEST_SHARD_INDEX: String(SHARD_INDEX) },
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testMatch: ["shortcuts.e2e.js", "sidebar.e2e.js"],
      use: {
        ...devices["iPhone 14"],
        browserName: "chromium",
      },
    },
    {
      name: "tablet",
      testMatch: "sidebar.e2e.js",
      use: {
        ...devices["iPad (gen 7)"],
        browserName: "chromium",
      },
    },
  ],
});
