/**
 * Critical Security Tests: Credential Revocation
 *
 * SECURITY REQUIREMENT: When a credential (passkey/device) is revoked, all associated
 * sessions MUST be immediately invalidated and active connections MUST be closed.
 *
 * This prevents the security vulnerability where a revoked device can still access
 * the terminal because its session cookie remains valid.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AuthState } from '../lib/auth-state.js';
import { randomBytes } from 'node:crypto';

describe('Credential Revocation Security', () => {
  let testState;
  let credential1;
  let credential2;
  let session1;
  let session2;
  let session3;

  beforeEach(() => {
    // Create test credentials
    credential1 = {
      id: 'cred-1',
      publicKey: Buffer.from('test-key-1').toString('base64url'),
      counter: 0,
      deviceId: 'device-1',
      name: 'Test Device 1',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: 'Test/1.0'
    };

    credential2 = {
      id: 'cred-2',
      publicKey: Buffer.from('test-key-2').toString('base64url'),
      counter: 0,
      deviceId: 'device-2',
      name: 'Test Device 2',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: 'Test/1.0'
    };

    // Create test sessions linked to credentials
    session1 = {
      credentialId: 'cred-1',
      expiry: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };

    session2 = {
      credentialId: 'cred-1', // Same credential as session1
      expiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };

    session3 = {
      credentialId: 'cred-2', // Different credential
      expiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
      lastActivityAt: Date.now()
    };

    testState = new AuthState({
      user: { id: 'test-user', name: 'Test User' },
      credentials: [credential1, credential2],
      sessions: {
        'token-1': session1,
        'token-2': session2,
        'token-3': session3
      },
      setupTokens: []
    });
  });

  describe('Session Validation', () => {
    it('should validate sessions for existing credentials', () => {
      assert.strictEqual(testState.isValidSession('token-1'), true);
      assert.strictEqual(testState.isValidSession('token-2'), true);
      assert.strictEqual(testState.isValidSession('token-3'), true);
    });

    it('should IMMEDIATELY invalidate sessions when credential is removed', () => {
      // Remove credential1
      const newState = testState.removeCredential('cred-1');

      // Sessions linked to removed credential MUST be invalid
      assert.strictEqual(newState.isValidSession('token-1'), false,
        'Session token-1 should be invalid after credential revoked');
      assert.strictEqual(newState.isValidSession('token-2'), false,
        'Session token-2 should be invalid after credential revoked');

      // Sessions linked to other credentials should still be valid
      assert.strictEqual(newState.isValidSession('token-3'), true,
        'Session token-3 should remain valid (different credential)');
    });

    it('should reject sessions without credentialId (old format)', () => {
      const stateWithOldSession = new AuthState({
        user: { id: 'test-user', name: 'Test User' },
        credentials: [credential1],
        sessions: {
          'old-token': { expiry: Date.now() + 1000000 } // Missing credentialId
        },
        setupTokens: []
      });

      assert.strictEqual(stateWithOldSession.isValidSession('old-token'), false,
        'Old format sessions without credentialId must be rejected');
    });

    it('should reject sessions with null credentialId (old pairing sessions)', () => {
      const stateWithNullCred = new AuthState({
        user: { id: 'test-user', name: 'Test User' },
        credentials: [credential1],
        sessions: {
          'pairing-token': { credentialId: null, expiry: Date.now() + 1000000 }
        },
        setupTokens: []
      });

      assert.strictEqual(stateWithNullCred.isValidSession('pairing-token'), false,
        'Pairing sessions with null credentialId must be rejected');
    });

    it('should reject expired sessions even if credential exists', () => {
      const expiredSession = {
        credentialId: 'cred-1',
        expiry: Date.now() - 1000, // Expired 1 second ago
        createdAt: Date.now() - 100000,
        lastActivityAt: Date.now() - 1000
      };

      const stateWithExpired = new AuthState({
        user: { id: 'test-user', name: 'Test User' },
        credentials: [credential1],
        sessions: { 'expired-token': expiredSession },
        setupTokens: []
      });

      assert.strictEqual(stateWithExpired.isValidSession('expired-token'), false,
        'Expired sessions must be rejected');
    });
  });

  describe('removeCredential()', () => {
    it('should remove credential and all associated sessions', () => {
      const newState = testState.removeCredential('cred-1');

      // Credential should be removed
      assert.strictEqual(newState.credentials.length, 1);
      assert.strictEqual(newState.credentials[0].id, 'cred-2');

      // Sessions for removed credential should be gone
      assert.strictEqual(newState.sessions['token-1'], undefined,
        'Session token-1 should be removed');
      assert.strictEqual(newState.sessions['token-2'], undefined,
        'Session token-2 should be removed');

      // Session for other credential should remain
      assert.ok(newState.sessions['token-3'],
        'Session token-3 should still exist');
    });

    it('should throw error when removing last credential', () => {
      // Remove credential2 first
      const stateWithOneCred = testState.removeCredential('cred-2');

      // Try to remove the last credential - should throw
      assert.throws(
        () => stateWithOneCred.removeCredential('cred-1'),
        /Cannot remove the last credential/i,
        'Should prevent removing the last credential to avoid lockout'
      );
    });

    it('should handle removal of non-existent credential gracefully', () => {
      const newState = testState.removeCredential('non-existent-id');

      // State should be unchanged
      assert.strictEqual(newState.credentials.length, 2);
      assert.strictEqual(Object.keys(newState.sessions).length, 3);
    });
  });

  describe('Token Revocation with Linked Credential', () => {
    it('should remove both setup token and linked credential when token is revoked', () => {
      // Create a setup token linked to a credential
      const setupToken = {
        id: 'token-id-1',
        token: 'token-value-1',
        name: 'Test Token',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        credentialId: 'cred-1' // Linked to credential1
      };

      const stateWithToken = new AuthState({
        user: testState.user,
        credentials: testState.credentials,
        sessions: testState.sessions,
        setupTokens: [setupToken]
      });

      // Simulate token revocation (what DELETE /api/tokens does)
      let newState = stateWithToken.removeSetupToken('token-id-1');
      newState = newState.removeCredential('cred-1');

      // Setup token should be removed
      assert.strictEqual(newState.setupTokens.length, 0);

      // Linked credential should be removed
      assert.strictEqual(newState.credentials.some(c => c.id === 'cred-1'), false);

      // All sessions for that credential should be invalid
      assert.strictEqual(newState.isValidSession('token-1'), false);
      assert.strictEqual(newState.isValidSession('token-2'), false);
    });
  });

  describe('Security Edge Cases', () => {
    it('should not allow credential resurrection through session manipulation', () => {
      // Remove credential
      const newState = testState.removeCredential('cred-1');

      // Try to create a new state with the old session but without the credential
      // This simulates an attacker trying to keep a session alive
      const attemptedState = new AuthState({
        user: newState.user,
        credentials: newState.credentials, // credential1 is gone
        sessions: {
          'token-1': session1 // But trying to keep session1 which points to cred-1
        },
        setupTokens: []
      });

      // Session should be invalid because credential doesn't exist
      assert.strictEqual(attemptedState.isValidSession('token-1'), false,
        'Session for non-existent credential must be invalid (prevents resurrection attack)');
    });

    it('should validate sessions against current credentials, not session data', () => {
      // This ensures isValidSession() does a LIVE check of credentials,
      // not just checking if session.credentialId field exists
      const newState = testState.removeCredential('cred-1');

      // Even though session1 has credentialId: 'cred-1' in its data,
      // it should be invalid because credential1 no longer exists in state
      assert.strictEqual(newState.isValidSession('token-1'), false);
    });
  });
});
