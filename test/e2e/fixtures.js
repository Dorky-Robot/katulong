/**
 * E2E Test Fixtures
 *
 * Sets up test data (devices, tokens) before tests run
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BASE_URL, TEST_DATA_DIR } from './test-config.js';

/**
 * Create a fixture auth state with a real credential
 * This allows testing credential revocation
 */
export function createFixtureAuthState() {
  try {
    // Create data directory if it doesn't exist
    mkdirSync(TEST_DATA_DIR, { recursive: true });

    // Create a fixture credential (simulates a paired device)
    const fixtureCredential = {
      id: 'e2e-test-credential-1',
      publicKey: Buffer.from('e2e-test-public-key').toString('base64url'),
      counter: 0,
      deviceId: 'e2e-test-device-1',
      name: 'E2E Test Device',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: 'Playwright/Test'
    };

    // Create a session linked to this credential
    const sessionToken = 'e2e-test-session-token';
    const session = {
      credentialId: fixtureCredential.id,
      expiry: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };

    // Create a setup token linked to the credential
    const setupToken = {
      id: 'e2e-test-token-id',
      token: 'e2e-test-token-value',
      name: 'E2E Test Token',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      credentialId: fixtureCredential.id
    };

    // Create the auth state
    const authState = {
      user: {
        id: 'e2e-test-user',
        name: 'E2E Test User'
      },
      credentials: [fixtureCredential],
      sessions: {
        [sessionToken]: session
      },
      setupTokens: [setupToken]
    };

    // Write to katulong-auth.json (the actual filename the server uses)
    const authPath = join(TEST_DATA_DIR, 'katulong-auth.json');
    writeFileSync(authPath, JSON.stringify(authState, null, 2));

    console.log('[Fixtures] Created fixture auth state with credential:', fixtureCredential.id);
    console.log('[Fixtures] Created fixture token:', setupToken.name);

    return {
      credential: fixtureCredential,
      setupToken: setupToken,
      sessionToken: sessionToken
    };
  } catch (err) {
    console.error('[Fixtures] Failed to create auth state:', err.message);
    return null;
  }
}

/**
 * Create test tokens via API
 */
export async function createTestTokens(page) {
  const tokens = [];

  try {
    // Create a test token
    const response = await page.request.post(`${BASE_URL}/api/tokens`, {
      data: {
        name: 'E2E Test Token'
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
 * Note: Auth state with credential should be created before this runs (by pre-server-setup.js)
 */
export async function setupTestFixtures(page) {
  console.log('[Fixtures] Setting up test data...');

  // Check what we have (devices and tokens from the auth state we created earlier)
  const devices = await createTestDevice(page);

  // Don't create additional tokens - we already have fixture token from pre-server-setup
  // Creating a new token here would create one without a credential link

  console.log('[Fixtures] Setup complete - devices:', devices.length);

  return { devices };
}

/**
 * Cleanup test fixtures
 */
export async function cleanupTestFixtures(page) {
  // Delete test tokens
  try {
    const response = await page.request.get(`${BASE_URL}/api/tokens`);
    if (response.ok()) {
      const data = await response.json();
      const testTokens = data.tokens.filter(t => t.name && t.name.includes('E2E Test'));

      for (const token of testTokens) {
        await page.request.delete(`${BASE_URL}/api/tokens/${token.id}`);
        console.log('[Fixtures] Deleted test token:', token.name);
      }
    }
  } catch (err) {
    console.log('[Fixtures] Cleanup warning:', err.message);
  }
}
