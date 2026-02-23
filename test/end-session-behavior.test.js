/**
 * End Session Behavior Tests
 *
 * REQUIREMENT: "End Session" permanently removes the credential and all sessions.
 * This is different from the old "logout" which only removed the session.
 *
 * User expectation: Clicking "End Session" means "I'm done with this device,
 * remove it completely." To use the terminal again, they must re-pair.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { AuthState } from '../lib/auth-state.js';

describe('End Session Behavior', () => {
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
      name: 'Android 10',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: 'Test/1.0'
    };

    credential2 = {
      id: 'cred-2',
      publicKey: Buffer.from('test-key-2').toString('base64url'),
      counter: 0,
      deviceId: 'device-2',
      name: 'iPhone 15',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      userAgent: 'Test/1.0'
    };

    // Create test sessions linked to credentials
    session1 = {
      credentialId: 'cred-1',
      expiry: Date.now() + 30 * 24 * 60 * 60 * 1000,
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
        'session-token-1': session1,
        'session-token-2': session2,
        'session-token-3': session3
      },
      setupTokens: []
    });
  });

  describe('endSession()', () => {
    it('should remove credential and all its sessions', () => {
      const sessionToken = 'session-token-1';
      const session = testState.sessions[sessionToken];

      // End session should remove credential and all sessions for that credential
      const { state: newState } = testState.endSession(sessionToken);

      // Credential should be removed
      assert.strictEqual(
        newState.credentials.find(c => c.id === session.credentialId),
        undefined,
        'Credential should be removed'
      );

      // All sessions for that credential should be removed
      assert.strictEqual(newState.sessions['session-token-1'], undefined);
      assert.strictEqual(newState.sessions['session-token-2'], undefined);

      // Sessions for other credentials should remain
      assert.ok(newState.sessions['session-token-3']);
    });

    it('should handle session without credential gracefully', () => {
      // Create a session without a linked credential
      const orphanSession = {
        credentialId: 'non-existent-cred',
        expiry: Date.now() + 1000000,
        createdAt: Date.now(),
        lastActivityAt: Date.now()
      };

      const stateWithOrphan = new AuthState({
        user: testState.user,
        credentials: testState.credentials,
        sessions: {
          ...testState.sessions,
          'orphan-token': orphanSession
        },
        setupTokens: []
      });

      // Should remove session but not crash
      const { state: newState } = stateWithOrphan.endSession('orphan-token');

      assert.strictEqual(newState.sessions['orphan-token'], undefined);
      // Other sessions should remain
      assert.ok(newState.sessions['session-token-1']);
    });

    it('should throw error when ending session for last credential', () => {
      // Remove credential2 first
      const stateWithOneCred = testState.removeCredential('cred-2');

      // Try to end session for the last credential - should throw
      assert.throws(
        () => stateWithOneCred.endSession('session-token-1'),
        /Cannot end session.*last credential/i,
        'Should prevent ending session for last credential (prevents lockout)'
      );
    });

    it('should allow ending session for last credential with allowRemoveLast', () => {
      // Remove credential2 first
      const stateWithOneCred = testState.removeCredential('cred-2');

      // With allowRemoveLast, ending session for the last credential should succeed
      const { state: newState, removedCredentialId } = stateWithOneCred.endSession('session-token-1', { allowRemoveLast: true });

      assert.strictEqual(newState.credentials.length, 0,
        'All credentials should be removed');
      assert.strictEqual(Object.keys(newState.sessions).length, 0,
        'All sessions should be removed');
      assert.strictEqual(removedCredentialId, 'cred-1',
        'Should report which credential was removed');
    });

    it('should still throw on last credential without allowRemoveLast', () => {
      const stateWithOneCred = testState.removeCredential('cred-2');

      assert.throws(
        () => stateWithOneCred.endSession('session-token-1'),
        /Cannot end session.*last credential/i,
        'Should prevent ending session for last credential by default'
      );
    });

    it('should handle invalid session token gracefully', () => {
      const { state: newState, removedCredentialId } = testState.endSession('non-existent-session');

      // State should be unchanged
      assert.strictEqual(newState.credentials.length, 2);
      assert.strictEqual(Object.keys(newState.sessions).length, 3);
      assert.strictEqual(removedCredentialId, null);
    });

    it('should also remove linked setup tokens', () => {
      // Create a setup token linked to credential1
      const setupToken = {
        id: 'token-id-1',
        token: 'token-value-1',
        name: 'Test Token',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        credentialId: 'cred-1'
      };

      const stateWithToken = new AuthState({
        user: testState.user,
        credentials: testState.credentials,
        sessions: testState.sessions,
        setupTokens: [setupToken]
      });

      // End session for credential1
      const { state: newState } = stateWithToken.endSession('session-token-1');

      // Setup token should be removed
      assert.strictEqual(
        newState.setupTokens.find(t => t.credentialId === 'cred-1'),
        undefined,
        'Setup token linked to credential should be removed'
      );
    });

    it('should return credentialId that was removed', () => {
      const { removedCredentialId } = testState.endSession('session-token-1');

      // Should be able to identify which credential was removed (for UI updates)
      assert.strictEqual(removedCredentialId, 'cred-1');
    });
  });

  describe('Integration with existing methods', () => {
    it('should invalidate sessions after endSession', () => {
      const { state: newState } = testState.endSession('session-token-1');

      // Sessions should be invalid
      assert.strictEqual(newState.isValidSession('session-token-1'), false);
      assert.strictEqual(newState.isValidSession('session-token-2'), false);

      // Other credential's session should still be valid
      assert.strictEqual(newState.isValidSession('session-token-3'), true);
    });

    it('should remove credential from getCredentialsWithMetadata', () => {
      const { state: newState } = testState.endSession('session-token-1');
      const credentials = newState.getCredentialsWithMetadata();

      // Should only have credential2
      assert.strictEqual(credentials.length, 1);
      assert.strictEqual(credentials[0].id, 'cred-2');
    });
  });
});
