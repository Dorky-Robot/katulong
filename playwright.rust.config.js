// Playwright config for the Rust backend e2e suite.
//
// Distinct from the main `playwright.config.js`: the Rust e2e
// suite does NOT spin up its own server. Tests assume the Rust
// backend is already reachable at `KATULONG_BASE_URL` — typically
// the local port allocated by `bin/katulong-stage` in `--rust`
// mode, or the public staging URL.
//
// Run:
//   KATULONG_BASE_URL=http://127.0.0.1:3050 \
//     npx playwright test --config=playwright.rust.config.js
//
//   KATULONG_BASE_URL=https://rewrite-rust-leptos.felixflor.es \
//     npx playwright test --config=playwright.rust.config.js
//
// The default base URL points at localhost so a developer who's
// just run `KATULONG_STAGE_BACKEND=rust bin/katulong-stage start`
// can run the suite without thinking about flags.
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.KATULONG_BASE_URL || "http://127.0.0.1:3050";

export default defineConfig({
  testDir: "test/e2e-rust",
  testMatch: "*.e2e.js",
  fullyParallel: true,
  workers: 1,
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
