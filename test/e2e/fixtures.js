/**
 * E2E Test Fixtures
 *
 * Sets up test data (devices, tokens) before tests run
 */

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

/**
 * Create test tokens via API
 */
export async function createTestTokens(page) {
  const tokens = [];

  try {
    // Create a test token
    const response = await page.request.post(`${BASE_URL}/auth/tokens`, {
      data: {
        name: 'E2E Test Token',
        ttl: 0 // Never expires
      }
    });

    if (response.ok()) {
      const data = await response.json();
      tokens.push(data);
      console.log('[Fixtures] Created test token:', data.name);
    }
  } catch (err) {
    console.log('[Fixtures] Could not create token:', err.message);
  }

  return tokens;
}

/**
 * Create test device via API
 * Since WebAuthn pairing is complex, we'll check if devices exist
 */
export async function createTestDevice(page) {
  try {
    // The app runs with KATULONG_NO_AUTH=1, so we're already "authenticated"
    const response = await page.request.get(`${BASE_URL}/auth/devices`);

    if (response.ok()) {
      const data = await response.json();
      const devices = data.devices || [];

      if (devices.length > 0) {
        console.log('[Fixtures] Found existing devices:', devices.length);
        return devices;
      }
    }

    console.log('[Fixtures] No devices found - tests will skip device-dependent scenarios');
  } catch (err) {
    console.log('[Fixtures] Could not check devices:', err.message);
  }

  return [];
}

/**
 * Setup all test fixtures
 */
export async function setupTestFixtures(page) {
  console.log('[Fixtures] Setting up test data...');

  const devices = await createTestDevice(page);
  const tokens = await createTestTokens(page);

  console.log('[Fixtures] Setup complete - devices:', devices.length, 'tokens:', tokens.length);

  return { devices, tokens };
}

/**
 * Cleanup test fixtures
 */
export async function cleanupTestFixtures(page) {
  // Delete test tokens
  try {
    const response = await page.request.get(`${BASE_URL}/auth/tokens`);
    if (response.ok()) {
      const data = await response.json();
      const testTokens = data.tokens.filter(t => t.name && t.name.includes('E2E Test'));

      for (const token of testTokens) {
        await page.request.delete(`${BASE_URL}/auth/tokens/${token.id}`);
        console.log('[Fixtures] Deleted test token:', token.name);
      }
    }
  } catch (err) {
    console.log('[Fixtures] Cleanup warning:', err.message);
  }
}
