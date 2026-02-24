/**
 * Global setup for E2E tests
 * Runs once before all tests
 *
 * Auth state and test data are created by pre-server-setup.js before the
 * webServer starts. Individual tests navigate and wait via setupTest() in
 * beforeEach, so no browser work is needed here.
 */

export default async function globalSetup() {
  console.log('\n[Global Setup] Test environment ready\n');
}
