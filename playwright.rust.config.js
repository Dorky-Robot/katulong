// Playwright config for the Rust backend e2e suite.
//
// Distinct from the main `playwright.config.js`: the Rust e2e
// suite does NOT spin up its own server. Tests assume the Rust
// backend is already reachable at `KATULONG_BASE_URL` — typically
// the local port allocated by `bin/katulong-stage` in `--rust`
// mode, or the public staging URL.
//
// Run:
//   npx playwright test --config=playwright.rust.config.js
//
//   KATULONG_BASE_URL=https://rewrite-rust-leptos.felixflor.es \
//     npx playwright test --config=playwright.rust.config.js
//
// The default base URL is `http://localhost:3050` and NOT
// `http://127.0.0.1:3050`. The webauthn happy-path suite
// (test/e2e-rust/webauthn.e2e.js) drives Chromium's virtual
// authenticator, which enforces the WebAuthn spec rule that
// the page's origin host must be a registrable suffix of the
// configured RP ID. Katulong's default RP ID is "localhost"
// (see crates/server/src/main.rs:126), and the browser does
// not consider "127.0.0.1" a registrable suffix of that, so
// passkey ceremonies on `http://127.0.0.1:3050` reject with
// "SecurityError: This is an invalid domain." The token-rejection
// tests in auth.e2e.js wouldn't surface this — they stub the
// network — so the failure only appears when a real ceremony
// runs.
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.KATULONG_BASE_URL || "http://localhost:3050";

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
