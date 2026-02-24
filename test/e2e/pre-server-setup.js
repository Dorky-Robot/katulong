/**
 * Pre-Server Setup
 * Runs BEFORE the Playwright webServer starts
 * Creates fixture auth state so the server loads it on startup
 */

import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { TEST_DATA_DIR } from './test-config.js';
import { writeAuthFixture } from '../helpers/auth-fixture.js';

function setupFixtureAuthState() {
  console.log('[Pre-Server Setup] Creating fixture auth state...');

  // Clean and create test data directory
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (err) {
    // Directory might not exist yet
  }

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

  // Write as per-entity files (the format the server uses)
  writeAuthFixture(TEST_DATA_DIR, authState);

  console.log('[Pre-Server Setup] Created fixture auth state at', TEST_DATA_DIR);
  console.log('[Pre-Server Setup] Fixture credential:', fixtureCredential.id);
  console.log('[Pre-Server Setup] Fixture token:', setupToken.name);
}

// Run setup
setupFixtureAuthState();
