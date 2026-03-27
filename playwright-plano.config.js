import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "plano.e2e.js",
  timeout: 15000,
  use: { baseURL: "http://localhost:3005", headless: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
